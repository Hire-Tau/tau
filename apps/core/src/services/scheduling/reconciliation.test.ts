import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { db } from '../../db'
import { agents, scheduleHealthEvents, scheduleHealthNotifications, schedules, squads } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { eq } from 'drizzle-orm'
import {
  reconcileSchedulesForDormantAgent,
  reconcileSchedulesForTerminatedAgent,
  reconcileSchedulesOnStartup,
  setUnavailableScheduleDiscoveredHookForTest,
} from './reconciliation'

let squadId: string
let target: Agent

beforeEach(async () => {
  const [squad] = await db
    .insert(squads)
    .values({ name: `reconcile-${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  squadId = squad.id
  const [row] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId }).returning()
  target = new Agent(row)
})

afterEach(async () => {
  setUnavailableScheduleDiscoveredHookForTest(undefined)
  await db.delete(squads).where(eq(squads.id, squadId))
})

describe('schedule target reconciliation', () => {
  it('converges seeded expiry, invalid target, and duplicate watchdog state on startup', async () => {
    const now = new Date()
    const [expired] = await db
      .insert(schedules)
      .values({
        scopeType: 'squad',
        scopeId: squadId,
        name: 'Expired startup',
        schedule: { interval: '1h', expiresAt: new Date(now.getTime() - 1_000).toISOString() },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: target.id }, content: 'x' },
        nextTriggerAt: new Date(now.getTime() - 1_000),
      })
      .returning()
    const [invalid] = await db
      .insert(schedules)
      .values({
        scopeType: 'squad',
        scopeId: squadId,
        name: 'Invalid startup',
        schedule: { interval: '1h' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: crypto.randomUUID() }, content: 'x' },
        nextTriggerAt: now,
      })
      .returning()
    const [child] = await db
      .insert(agents)
      .values({ agentTypeId: 'engineer', squadId, parentAgentId: target.id })
      .returning()
    for (let duplicate = 0; duplicate < 2; duplicate++) {
      await db.insert(schedules).values({
        scopeType: 'agent',
        scopeId: target.id,
        name: `Watchdog ${duplicate}`,
        schedule: { interval: '15m' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: target.id }, content: 'check_subagents' },
        metadata: { kind: 'subagent-watchdog' },
      })
    }

    const summary = await reconcileSchedulesOnStartup(now)

    expect(summary.repaired).toBeGreaterThanOrEqual(3)
    expect((await db.select().from(schedules).where(eq(schedules.id, expired.id)))[0].automaticDisableReason).toMatch(
      /^Schedule expired at /
    )
    expect(
      (await db.select().from(schedules).where(eq(schedules.id, invalid.id)))[0].automaticallyDisabledAt
    ).not.toBeNull()
    expect(
      (await db.select().from(schedules).where(eq(schedules.scopeId, target.id))).filter(
        (row) =>
          row.systemKey?.startsWith('subagent-watchdog:') ||
          (row.metadata as Record<string, unknown>)?.kind === 'subagent-watchdog'
      )
    ).toHaveLength(1)
    await db.delete(agents).where(eq(agents.id, child.id))
  })

  it('permanently disables timer and webhook delivery for a dormant target and removes its watchdog', async () => {
    const [scheduled] = await db
      .insert(schedules)
      .values({
        scopeType: 'agent',
        scopeId: target.id,
        name: 'Dormant target',
        schedule: { interval: '1h' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: target.id }, content: 'x' },
        nextTriggerAt: new Date(),
        webhookEnabled: true,
        webhookTokenHash: 'test-token-hash',
      })
      .returning()
    const [watchdog] = await db
      .insert(schedules)
      .values({
        scopeType: 'agent',
        scopeId: target.id,
        name: 'Dormant watchdog',
        schedule: { interval: '15m' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: target.id }, content: 'check_subagents' },
        metadata: { kind: 'subagent-watchdog' },
      })
      .returning()
    const dormantAt = new Date(Math.max(scheduled.updatedAt.getTime(), watchdog.updatedAt.getTime()) + 1)
    await db
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt,
        metadata: { ...(target.metadata ?? {}), dormancyCompletionId: crypto.randomUUID() },
      })
      .where(eq(agents.id, target.id))
    await target.reload()
    // A post-dormancy edit must not escape permanent disablement while the
    // target still points at this exact dormant agent.
    await db
      .update(schedules)
      .set({ updatedAt: new Date(dormantAt.getTime() + 1) })
      .where(eq(schedules.id, scheduled.id))

    expect(await reconcileSchedulesForDormantAgent(target)).toEqual({ scanned: 1, repaired: 1, failed: 0 })
    expect(await reconcileSchedulesForDormantAgent(target)).toEqual({ scanned: 0, repaired: 0, failed: 0 })

    let [row] = await db.select().from(schedules).where(eq(schedules.id, scheduled.id))
    expect(row).toMatchObject({
      enabled: false,
      webhookEnabled: false,
      lastErrorCode: 'target_agent_dormant',
      automaticDisableReason: 'Target agent is dormant; automatic schedule delivery was permanently disabled.',
    })
    expect(await db.select().from(schedules).where(eq(schedules.id, watchdog.id))).toHaveLength(0)

    await db.update(agents).set({ status: 'idle', dormantAt: null }).where(eq(agents.id, target.id))
    ;[row] = await db.select().from(schedules).where(eq(schedules.id, scheduled.id))
    expect(row).toMatchObject({ enabled: false, webhookEnabled: false })
  })

  it('does not disable or mark a schedule retargeted after dormant discovery', async () => {
    const [replacement] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId }).returning()
    const [scheduled] = await db
      .insert(schedules)
      .values({
        scopeType: 'squad',
        scopeId: squadId,
        name: 'Retargeted during dormancy',
        schedule: { interval: '1h' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: target.id }, content: 'x' },
        nextTriggerAt: new Date(),
        webhookEnabled: true,
        webhookTokenHash: 'test-token-hash',
      })
      .returning()
    await db
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt: new Date(),
        metadata: { ...(target.metadata ?? {}), dormancyCompletionId: crypto.randomUUID() },
      })
      .where(eq(agents.id, target.id))
    await target.reload()
    setUnavailableScheduleDiscoveredHookForTest(async (scheduleId) => {
      setUnavailableScheduleDiscoveredHookForTest(undefined)
      await db
        .update(schedules)
        .set({
          action: { type: 'inbox_message', target: { type: 'agent', agentId: replacement.id }, content: 'x' },
          updatedAt: new Date(Date.now() + 1_000),
        })
        .where(eq(schedules.id, scheduleId))
    })

    expect(await reconcileSchedulesForDormantAgent(target)).toEqual({ scanned: 1, repaired: 0, failed: 0 })
    const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduled.id))
    expect(row).toMatchObject({ enabled: true, webhookEnabled: true, lastErrorCode: null })
  })

  it('does not let stale dormancy reconciliation delete a post-wake watchdog', async () => {
    const dormantAt = new Date('2026-09-02T00:00:00.000Z')
    const episodeId = crypto.randomUUID()
    await db
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt,
        metadata: { ...(target.metadata ?? {}), dormancyCompletionId: episodeId, dormancyCompletionPending: true },
      })
      .where(eq(agents.id, target.id))
    const staleDormant = await Agent.mustFind(target.id)
    await db
      .update(agents)
      .set({
        status: 'idle',
        dormantAt: null,
        metadata: { ...(target.metadata ?? {}), resourceGeneration: crypto.randomUUID() },
      })
      .where(eq(agents.id, target.id))
    const [watchdog] = await db
      .insert(schedules)
      .values({
        scopeType: 'agent',
        scopeId: target.id,
        name: 'Post-wake watchdog',
        schedule: { interval: '15m' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: target.id }, content: 'check_subagents' },
        systemKey: `subagent-watchdog:${target.id}`,
        metadata: { kind: 'subagent-watchdog' },
        updatedAt: new Date(dormantAt.getTime() - 1),
      })
      .returning()

    await reconcileSchedulesForDormantAgent(staleDormant)

    expect(await db.select().from(schedules).where(eq(schedules.id, watchdog.id))).toHaveLength(1)
  })

  it('preserves a watchdog created after the current dormancy cutoff', async () => {
    const dormantAt = new Date('2026-09-02T00:00:00.000Z')
    await db
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt,
        metadata: { ...(target.metadata ?? {}), dormancyCompletionId: crypto.randomUUID() },
      })
      .where(eq(agents.id, target.id))
    const dormant = await Agent.mustFind(target.id)
    const [watchdog] = await db
      .insert(schedules)
      .values({
        scopeType: 'agent',
        scopeId: target.id,
        name: 'New dormancy watchdog',
        schedule: { interval: '15m' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: target.id }, content: 'check_subagents' },
        systemKey: `subagent-watchdog:${target.id}`,
        metadata: { kind: 'subagent-watchdog' },
        updatedAt: new Date(dormantAt.getTime() + 1),
      })
      .returning()

    await reconcileSchedulesForDormantAgent(dormant)

    expect(await db.select().from(schedules).where(eq(schedules.id, watchdog.id))).toHaveLength(1)
  })

  it('retains and permanently disables every user schedule targeting a terminated agent', async () => {
    const values = [
      {
        scopeType: 'agent' as const,
        scopeId: target.id,
        action: {
          type: 'inbox_message' as const,
          target: { type: 'agent' as const, agentId: target.id },
          content: 'x',
        },
      },
      {
        scopeType: 'squad' as const,
        scopeId: squadId,
        action: {
          type: 'inbox_message' as const,
          target: { type: 'agent' as const, agentId: target.id },
          content: 'x',
        },
      },
      {
        scopeType: 'squad' as const,
        scopeId: squadId,
        action: { type: 'create_work_stream' as const, title: 'x', agentIds: [target.id], assigneeAgentId: target.id },
      },
    ]
    const created = []
    for (const [index, value] of values.entries()) {
      const [row] = await db
        .insert(schedules)
        .values({ ...value, name: `target-${index}`, schedule: { interval: '1h' }, nextTriggerAt: new Date() })
        .returning()
      created.push(row)
    }
    await db
      .update(agents)
      .set({ status: 'terminated', terminatedAt: new Date(Date.now() + 1_000) })
      .where(eq(agents.id, target.id))
    const terminated = await Agent.mustFind(target.id)
    await reconcileSchedulesForTerminatedAgent(terminated)
    await reconcileSchedulesForTerminatedAgent(terminated)

    for (const createdSchedule of created) {
      const [row] = await db.select().from(schedules).where(eq(schedules.id, createdSchedule.id))
      expect(row).toMatchObject({ enabled: false, webhookEnabled: false, failureCount: 1 })
      expect(row.automaticallyDisabledAt).not.toBeNull()
      const events = await db
        .select()
        .from(scheduleHealthEvents)
        .where(eq(scheduleHealthEvents.scheduleId, createdSchedule.id))
      expect(events.map((event) => event.kind).sort()).toEqual(['automatically_disabled', 'failed'])
      const notifications = await db
        .select()
        .from(scheduleHealthNotifications)
        .where(eq(scheduleHealthNotifications.scheduleId, createdSchedule.id))
      expect(notifications.map((notification) => notification.kind)).toEqual(['permanent_failure'])
    }
  })

  it('immediately disables every target while preserving an in-flight marker and cleaning watchdogs', async () => {
    const created = []
    for (let index = 0; index < 3; index++) {
      const [row] = await db
        .insert(schedules)
        .values({
          scopeType: 'squad',
          scopeId: squadId,
          name: `isolated-${index}`,
          schedule: { interval: '1h' },
          action: { type: 'inbox_message', target: { type: 'agent', agentId: target.id }, content: 'x' },
          nextTriggerAt: new Date(),
          ...(index === 1 && {
            activeAttemptId: crypto.randomUUID(),
            activeAttemptSource: 'manual' as const,
            activeAttemptStartedAt: new Date(),
            activeAttemptLeaseUntil: new Date(Date.now() + 60_000),
          }),
        })
        .returning()
      created.push(row)
    }
    const [watchdog] = await db
      .insert(schedules)
      .values({
        scopeType: 'agent',
        scopeId: target.id,
        name: 'Legacy watchdog',
        schedule: { interval: '15m' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: target.id }, content: 'check_subagents' },
        metadata: { kind: 'subagent-watchdog' },
      })
      .returning()
    await db
      .update(agents)
      .set({ status: 'terminated', terminatedAt: new Date(Date.now() + 1_000) })
      .where(eq(agents.id, target.id))
    const summary = await reconcileSchedulesForTerminatedAgent(await Agent.mustFind(target.id))
    expect(summary).toEqual({ scanned: 3, repaired: 3, failed: 0 })
    const rows = await Promise.all(
      created.map(async (row) => (await db.select().from(schedules).where(eq(schedules.id, row.id)))[0])
    )
    expect(rows.filter((row) => row.automaticallyDisabledAt)).toHaveLength(3)
    expect(rows[1].activeAttemptId).not.toBeNull()
    expect(await db.select().from(schedules).where(eq(schedules.id, watchdog.id))).toHaveLength(0)
  })

  it('deletes system-owned watchdogs instead of creating health incidents', async () => {
    const [watchdog] = await db
      .insert(schedules)
      .values({
        scopeType: 'agent',
        scopeId: target.id,
        name: 'Subagent watchdog',
        schedule: { interval: '15m' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: target.id }, content: 'check_subagents' },
        metadata: { kind: 'subagent-watchdog' },
      })
      .returning()
    await db
      .update(agents)
      .set({ status: 'terminated', terminatedAt: new Date(Date.now() + 1_000) })
      .where(eq(agents.id, target.id))
    await reconcileSchedulesForTerminatedAgent(await Agent.mustFind(target.id))
    expect(await db.select().from(schedules).where(eq(schedules.id, watchdog.id))).toHaveLength(0)
    expect(
      await db.select().from(scheduleHealthEvents).where(eq(scheduleHealthEvents.scheduleId, watchdog.id))
    ).toHaveLength(0)
  })
})
