import { ensureMessageQueryIndex } from '../../test-utils/message-query-indexes'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, messages, squads } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { messageSortAtSql, visibleMessageSql } from '../../entities/message-time'
import { eventEmitter } from '../../lib/infra/event-emitter'
import {
  ACTIVITY_REFRESH_DEBOUNCE_MS,
  agentActivityDrift,
  agentActivitySummarySql,
  flushPendingActivityRefreshes,
  refreshAgentActivity,
  registerAgentActivityEventHandlers,
} from './activity-summary'

/**
 * These columns replaced three correlated subqueries. The only thing that
 * matters is that they still say what the subqueries said — including on the
 * transitions that make an incremental "just write the newest" implementation
 * wrong, which is why refreshAgentActivity recomputes.
 */

/** What the OLD correlated subquery would have returned. The oracle. */
async function computeLastMessageAt(agentId: string): Promise<Date | null> {
  const [row] = await db
    .select({
      v: sql<Date | null>`(
        SELECT MAX(${messageSortAtSql})
        FROM ${messages}
        WHERE ${messages.agentId} = ${agentId}
          AND ${visibleMessageSql}
      )`.mapWith(messages.createdAt),
    })
    .from(agents)
    .where(eq(agents.id, agentId))
  return row?.v ?? null
}

async function stored(agentId: string) {
  const [row] = await db
    .select({
      lastMessageAt: agents.lastMessageAt,
      lastHumanMessageAt: agents.lastHumanMessageAt,
      lastMessagePreview: agents.lastMessagePreview,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
  return row
}

async function insertMessage(
  agentId: string,
  role: 'human' | 'assistant',
  content: string,
  opts: { pending?: boolean; createdAt?: Date; metadata?: Record<string, unknown> } = {}
) {
  const [row] = await db
    .insert(messages)
    .values({
      agentId,
      role,
      content,
      pending: opts.pending ?? false,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    })
    .returning()
  return row
}

describe('agent activity summary', () => {
  let prefix: string
  let agentTypeId: string
  let squad: Squad
  const made: Agent[] = []

  beforeEach(async () => {
    prefix = `activity-summary-${crypto.randomUUID()}`
    agentTypeId = `${prefix}-type`
    await AgentType.create({ id: agentTypeId, name: 'Activity summary', model: 'test:model', systemPrompt: 'test' })
    squad = await Squad.create({ name: prefix, purpose: 'activity summary tests' })
    made.length = 0
  })

  afterEach(async () => {
    // Settle any debounced refresh BEFORE the fixtures go. An unsettled
    // fire-and-forget write outlives this file and lands during the next one.
    await flushPendingActivityRefreshes()
    for (const a of made) await db.delete(agents).where(eq(agents.id, a.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  })

  async function createTestAgent(): Promise<Agent> {
    const agent = await Agent.create({ agentTypeId, squadId: squad.id })
    made.push(agent)
    return agent
  }

  async function assertSummaryMatchesOracle(agentId: string) {
    const [oracle] = await db.execute(sql`
      SELECT MAX(${messageSortAtSql}) AS last_message_at,
        MAX(${messageSortAtSql}) FILTER (WHERE ${messages.role} = 'human') AS last_human_message_at,
        (SELECT LEFT(${messages.content}, 280) FROM ${messages}
          WHERE ${messages.agentId} = ${agentId} AND ${visibleMessageSql}
          ORDER BY ${messageSortAtSql} DESC, ${messages.id} DESC LIMIT 1) AS last_message_preview
      FROM ${messages} WHERE ${messages.agentId} = ${agentId} AND ${visibleMessageSql}
    `)
    const [summary] = await db.execute(agentActivitySummarySql(agentId))
    expect(summary).toEqual(oracle)
  }

  test('preserves millisecond/id ties, offsets, non-inbox consumption and pending visibility', async () => {
    const agent = await createTestAgent()
    // Keep deterministic relative ordering without sharing primary keys with other tests.
    const messageIdPrefix = crypto.randomUUID().slice(0, -1)
    await assertSummaryMatchesOracle(agent.id)
    await db.execute(sql`INSERT INTO messages (id, agent_id, role, content, created_at, metadata, pending) VALUES
      (${messageIdPrefix + '1'}, ${agent.id}, 'assistant', 'later microsecond, smaller id', '2026-01-02 00:00:00.123999', NULL, false),
      (${messageIdPrefix + '9'}, ${agent.id}, 'assistant', 'millisecond winner', '2026-01-02 00:00:00.123001', NULL, false),
      (${messageIdPrefix + '8'}, ${agent.id}, 'human', 'same instant with offset', '2026-01-01', '{"consumedAt":"2026-01-02T02:00:00.123456+02:00"}', false),
      (${messageIdPrefix + '7'}, ${agent.id}, 'human', 'lexically newer but chronologically older', '2026-01-01', '{"source":"inbox","consumedAt":"2026-01-02T03:00:00.123456+04:00"}', false),
      (${messageIdPrefix + '6'}, ${agent.id}, 'assistant', 'pending future', '2027-01-01', NULL, true)
    `)
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL TIME ZONE 'America/New_York'`)
      await refreshAgentActivity(agent.id, tx)
    })
    expect((await stored(agent.id))?.lastMessagePreview).toBe('millisecond winner')
    await assertSummaryMatchesOracle(agent.id)
    await db.delete(messages).where(and(eq(messages.agentId, agent.id), eq(messages.role, 'assistant')))
    await assertSummaryMatchesOracle(agent.id)
    await db.update(messages).set({ pending: true }).where(eq(messages.agentId, agent.id))
    await assertSummaryMatchesOracle(agent.id)
  })

  test('summary buffer cost does not scan a long assistant transcript', async () => {
    await ensureMessageQueryIndex('idx_messages_agent_id_role_created_at')
    const agent = await createTestAgent()
    await db.execute(sql`INSERT INTO messages (agent_id, role, content, created_at, metadata)
      SELECT ${agent.id}::uuid, CASE WHEN n % 120 = 0 THEN 'human' ELSE 'assistant' END::message_role,
        repeat(md5(n::text), 20), '2026-01-01'::timestamp + n * interval '1 second',
        CASE WHEN n % 120 = 0 THEN jsonb_build_object('consumedAt', '2026-01-01'::timestamptz + n * interval '2 seconds') END
      FROM generate_series(1, 12000) n`)
    await db.execute(sql`ANALYZE messages`)
    await assertSummaryMatchesOracle(agent.id)
    const [explained] = await db.execute(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${agentActivitySummarySql(agent.id)}`
    )
    const plan = (explained['QUERY PLAN'] as any)[0].Plan
    const buffers = plan['Shared Hit Blocks'] + plan['Shared Read Blocks']
    const [oldExplained] = await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT (SELECT MAX(${messageSortAtSql}) FROM ${messages}
        WHERE ${messages.agentId} = ${agent.id} AND ${visibleMessageSql}),
        (SELECT MAX(${messageSortAtSql}) FROM ${messages}
        WHERE ${messages.agentId} = ${agent.id} AND ${messages.role} = 'human' AND ${visibleMessageSql}),
        (SELECT LEFT(${messages.content}, 280) FROM ${messages}
        WHERE ${messages.agentId} = ${agent.id} AND ${visibleMessageSql}
        ORDER BY ${messageSortAtSql} DESC, ${messages.id} DESC LIMIT 1)
    `)
    const oldPlan = (oldExplained['QUERY PLAN'] as any)[0].Plan
    const oldBuffers = oldPlan['Shared Hit Blocks'] + oldPlan['Shared Read Blocks']
    // Negative control: the former production query must fail the same budget.
    expect(oldBuffers).toBeGreaterThan(1500)
    expect(buffers).toBeLessThan(oldBuffers / 10)
    // The old query reads all 12,000 rows twice. A broad buffer budget, not a
    // wall-clock deadline: one human scan plus indexed assistant/preview reads.
    if (process.env.CORE_DB_PRINT_EXPLAIN === '1') console.log('activity summary', JSON.stringify(explained))
    expect(buffers).toBeLessThan(1500)
  })

  test('matches the correlated subquery it replaced', async () => {
    const agent = await createTestAgent()
    await insertMessage(agent.id, 'human', 'first', { createdAt: new Date('2026-01-01T00:00:00Z') })
    await insertMessage(agent.id, 'assistant', 'second', { createdAt: new Date('2026-01-02T00:00:00Z') })
    await refreshAgentActivity(agent.id)

    const row = await stored(agent.id)
    expect(row?.lastMessageAt?.getTime()).toBe((await computeLastMessageAt(agent.id))?.getTime())
    expect(row?.lastMessagePreview).toBe('second')
    expect(await agentActivityDrift(agent.id)).toBe(false)
  })

  test('tracks the newest HUMAN message separately', async () => {
    const agent = await createTestAgent()
    await insertMessage(agent.id, 'human', 'from a person', { createdAt: new Date('2026-01-01T00:00:00Z') })
    await insertMessage(agent.id, 'assistant', 'from the agent', { createdAt: new Date('2026-01-02T00:00:00Z') })
    await refreshAgentActivity(agent.id)

    const row = await stored(agent.id)
    expect(row?.lastHumanMessageAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(row?.lastMessageAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z')
  })

  // Pending rows are invisible to the summary. A pending message becoming
  // delivered ENTERS the set without any insert happening — the first of the
  // two transitions an incremental writer would miss.
  test('a pending message is excluded until it is delivered', async () => {
    const agent = await createTestAgent()
    await insertMessage(agent.id, 'human', 'delivered', { createdAt: new Date('2026-01-01T00:00:00Z') })
    const queued = await insertMessage(agent.id, 'human', 'still queued', {
      pending: true,
      createdAt: new Date('2026-01-05T00:00:00Z'),
    })
    await refreshAgentActivity(agent.id)
    expect((await stored(agent.id))?.lastMessagePreview).toBe('delivered')

    await db.update(messages).set({ pending: false }).where(eq(messages.id, queued.id))
    await refreshAgentActivity(agent.id)

    const row = await stored(agent.id)
    expect(row?.lastMessagePreview).toBe('still queued')
    expect(row?.lastMessageAt?.toISOString()).toBe('2026-01-05T00:00:00.000Z')
    expect(await agentActivityDrift(agent.id)).toBe(false)
  })

  // The second, nastier transition: consumedAt makes an OLDER row sort NEWEST,
  // long after it was inserted. "The newest message wins" is simply false here.
  test('a consumedAt stamp can make an older message the newest', async () => {
    const agent = await createTestAgent()
    const older = await insertMessage(agent.id, 'human', 'older, consumed later', {
      createdAt: new Date('2026-01-01T00:00:00Z'),
    })
    await insertMessage(agent.id, 'assistant', 'newer by created_at', {
      createdAt: new Date('2026-01-02T00:00:00Z'),
    })
    await refreshAgentActivity(agent.id)
    expect((await stored(agent.id))?.lastMessagePreview).toBe('newer by created_at')

    await db
      .update(messages)
      .set({ metadata: { consumedAt: '2026-01-09T00:00:00.000Z' } })
      .where(eq(messages.id, older.id))
    await refreshAgentActivity(agent.id)

    const row = await stored(agent.id)
    expect(row?.lastMessageAt?.toISOString()).toBe('2026-01-09T00:00:00.000Z')
    expect(row?.lastMessagePreview).toBe('older, consumed later')
    expect(await agentActivityDrift(agent.id)).toBe(false)
  })

  test('an agent with no visible messages reads null, not stale', async () => {
    const agent = await createTestAgent()
    const only = await insertMessage(agent.id, 'human', 'gone soon')
    await refreshAgentActivity(agent.id)
    expect((await stored(agent.id))?.lastMessagePreview).toBe('gone soon')

    await db.delete(messages).where(eq(messages.id, only.id))
    await refreshAgentActivity(agent.id)

    const row = await stored(agent.id)
    expect(row?.lastMessageAt).toBeNull()
    expect(row?.lastMessagePreview).toBeNull()
    expect(await agentActivityDrift(agent.id)).toBe(false)
  })

  test('the preview is capped and never bleeds another agent in', async () => {
    const a = await createTestAgent()
    const b = await createTestAgent()
    await insertMessage(b.id, 'human', 'BELONGS TO B')
    await insertMessage(a.id, 'human', 'x'.repeat(400))
    await refreshAgentActivity(a.id)

    const row = await stored(a.id)
    expect(row?.lastMessagePreview).toHaveLength(280)
    expect(row?.lastMessagePreview).not.toContain('BELONGS TO B')
  })

  test('drift is detectable — the check can actually fail', async () => {
    const agent = await createTestAgent()
    await insertMessage(agent.id, 'human', 'real')
    await refreshAgentActivity(agent.id)
    expect(await agentActivityDrift(agent.id)).toBe(false)

    // Write a wrong value directly, the way a missed write path would.
    await db
      .update(agents)
      .set({ lastMessageAt: new Date('2000-01-01T00:00:00Z') })
      .where(and(eq(agents.id, agent.id)))
    expect(await agentActivityDrift(agent.id)).toBe(true)
  })

  // A streaming agent emits a burst of message.updated events, each asking for
  // the same recompute. Undebounced that is one query per event.
  describe('debounce', () => {
    test('coalesces a burst into a single refresh, and does not drop the last', async () => {
      const agent = await createTestAgent()
      await insertMessage(agent.id, 'human', 'burst-1', { createdAt: new Date('2026-01-01T00:00:00Z') })
      const unregister = registerAgentActivityEventHandlers()
      try {
        for (let i = 0; i < 25; i++) {
          eventEmitter.emit('message.updated', { agentId: agent.id } as never)
        }
        // Nothing yet: trailing edge.
        expect((await stored(agent.id))?.lastMessagePreview).toBeNull()

        // The state that must survive is written DURING the window — a
        // leading-edge debounce would have refreshed before this and coalesced
        // the correction away.
        await insertMessage(agent.id, 'human', 'burst-last', { createdAt: new Date('2026-01-02T00:00:00Z') })
        await new Promise((r) => setTimeout(r, ACTIVITY_REFRESH_DEBOUNCE_MS + 400))

        expect((await stored(agent.id))?.lastMessagePreview).toBe('burst-last')
        expect(await agentActivityDrift(agent.id)).toBe(false)
      } finally {
        unregister()
      }
    })

    test("one agent's burst does not delay another agent", async () => {
      const a = await createTestAgent()
      const b = await createTestAgent()
      await insertMessage(a.id, 'human', 'for-a')
      await insertMessage(b.id, 'human', 'for-b')
      const unregister = registerAgentActivityEventHandlers()
      try {
        for (let i = 0; i < 10; i++) eventEmitter.emit('message.updated', { agentId: a.id } as never)
        eventEmitter.emit('message.updated', { agentId: b.id } as never)
        await new Promise((r) => setTimeout(r, ACTIVITY_REFRESH_DEBOUNCE_MS + 400))

        expect((await stored(a.id))?.lastMessagePreview).toBe('for-a')
        expect((await stored(b.id))?.lastMessagePreview).toBe('for-b')
      } finally {
        unregister()
      }
    })

    // A shutdown inside the window must not leave the column a message behind.
    test('unregister flushes a pending refresh instead of dropping it', async () => {
      const agent = await createTestAgent()
      await insertMessage(agent.id, 'human', 'written before shutdown')
      const unregister = registerAgentActivityEventHandlers()
      eventEmitter.emit('message.updated', { agentId: agent.id } as never)
      expect((await stored(agent.id))?.lastMessagePreview).toBeNull()

      unregister()
      await new Promise((r) => setTimeout(r, 300))
      expect((await stored(agent.id))?.lastMessagePreview).toBe('written before shutdown')
    })
  })
})
