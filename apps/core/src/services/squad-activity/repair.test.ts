import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, messages, squadActivity, squads } from '../../db/schema'
import { defaultRepairConcurrency, repairSquadActivity, validateRepairWindow } from './repair'

const squadIds: string[] = []
const messageIds: string[] = []
const DAY_MS = 24 * 60 * 60 * 1000
afterEach(async () => {
  // Delete the malformed-metadata message explicitly: squads/agents cleanup
  // does not cascade to it, and a leaked `executionId: 'not-a-uuid'` row makes
  // every LATER repair over the same window count one error (this exact leak
  // broke materialize.test.ts's overlapping-repair test in full-suite runs).
  for (const messageId of messageIds.splice(0)) await db.delete(messages).where(eq(messages.id, messageId))
  for (const squadId of squadIds.splice(0)) await db.delete(squads).where(eq(squads.id, squadId))
})

const window = {
  from: new Date('2026-08-01T00:00:00.000Z'),
  to: new Date('2026-08-02T00:00:00.000Z'),
}

describe('Activity repair bounds', () => {
  test('rejects non-finite and fractional page or concurrency bounds', () => {
    for (const pageSize of [Number.NaN, Number.POSITIVE_INFINITY, 1.5])
      expect(() => validateRepairWindow({ ...window, pageSize })).toThrow(TypeError)
    for (const concurrency of [Number.NaN, Number.POSITIVE_INFINITY, 1.5])
      expect(() => validateRepairWindow({ ...window, concurrency })).toThrow(TypeError)
  })

  test('retains bounded actionable context for isolated materialization failures', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-repair-failure-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const fixtureNow = new Date()
    // Keep repair-backed timestamps relative so they stay inside Activity retention as wall time advances.
    const createdAt = new Date(fixtureNow.getTime() - DAY_MS)
    expect(fixtureNow.getTime() - createdAt.getTime()).toBe(DAY_MS)
    const repairWindow = {
      from: new Date(createdAt.getTime() - 12 * 60 * 60_000),
      to: new Date(createdAt.getTime() + 12 * 60 * 60_000),
    }
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const [malformed] = await db
      .insert(messages)
      .values({
        agentId: agent.id,
        role: 'assistant',
        content: 'Malformed repair group',
        metadata: { executionId: 'not-a-uuid' },
        createdAt,
      })
      .returning()
    messageIds.push(malformed.id)
    const report = await repairSquadActivity(repairWindow)
    expect(report.families.chat.errors).toBe(1)
    expect(report.families.chat.failures).toEqual([
      expect.objectContaining({ phase: 'materialize', groupId: 'not-a-uuid' }),
    ])
    expect(report.families.chat.failures).toHaveLength(1)
    // Timing attribution is real measurement, not a hardcoded placeholder:
    // the total covers all families and the touched family recorded time.
    expect(report.elapsedMs).toBeGreaterThan(0)
    expect(report.families.chat.elapsedMs).toBeGreaterThan(0)
    expect(report.elapsedMs).toBeGreaterThanOrEqual(report.families.chat.elapsedMs)
  })

  test('default concurrency stays strictly below the pool, floored at 1', () => {
    const original = process.env.DATABASE_POOL_MAX
    try {
      for (const [poolMax, expected] of [
        ['1', 1],
        ['2', 1],
        ['3', 1],
        ['4', 2],
        ['8', 4],
        ['32', 4],
      ] as const) {
        process.env.DATABASE_POOL_MAX = poolMax
        expect(defaultRepairConcurrency()).toBe(expected)
      }
    } finally {
      if (original === undefined) delete process.env.DATABASE_POOL_MAX
      else process.env.DATABASE_POOL_MAX = original
    }
  })

  test('rejects a manual window wholly outside retained Activity history', async () => {
    await expect(
      repairSquadActivity({
        from: new Date('2020-01-01T00:00:00.000Z'),
        to: new Date('2020-01-02T00:00:00.000Z'),
      })
    ).rejects.toThrow(TypeError)
  })
})

describe('Activity repair projection pass', () => {
  // A chat row whose durable source is gone: only the projection anti-join pass
  // can find it, because a deleted source produces no facet in the source scan.
  const staleChatRow = (squadId: string, at: Date) => ({
    squadId,
    lane: 10,
    rowId: crypto.randomUUID(),
    sourceFamily: 'chat',
    sourceGroupId: crypto.randomUUID(),
    at,
    agentId: null,
    workStreamId: null,
    agentTypeId: null,
    kind: 'message' as const,
    summary: 'orphaned chat facet',
    ref: { type: 'agent' as const, agentId: crypto.randomUUID(), view: 'chat' as const },
    quietEligible: true,
    accessScope: 'agents' as const,
    inboxRecipientId: null,
    payloadHash: 'c'.repeat(64),
  })

  const seedStaleRow = async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-projection-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const at = new Date(Date.now() - 60 * 60_000)
    const stale = staleChatRow(squad.id, at)
    await db.insert(squadActivity).values(stale)
    return { squad, stale, window: { from: new Date(at.valueOf() - 60_000), to: new Date(Date.now() + 60_000) } }
  }

  const remaining = async (squadId: string) =>
    (await db.select().from(squadActivity).where(eq(squadActivity.squadId, squadId))).map((item) => item.rowId)

  test('deletes orphaned projection rows by default', async () => {
    const { squad, stale, window: repairWindow } = await seedStaleRow()
    const report = await repairSquadActivity({ ...repairWindow })
    expect(report.errors).toBe(0)
    expect(await remaining(squad.id)).not.toContain(stale.rowId)
  })

  test('skips the projection pass when it is disabled', async () => {
    const { squad, stale, window: repairWindow } = await seedStaleRow()
    const report = await repairSquadActivity({ ...repairWindow, projectionPass: false })
    expect(report.errors).toBe(0)
    expect(await remaining(squad.id)).toContain(stale.rowId)
  })
})
