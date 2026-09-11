import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { db } from '../../db'
import { scheduleHealthEvents, scheduleHealthNotifications, schedules, squads } from '../../db/schema'
import { eq } from 'drizzle-orm'
import {
  CIRCUIT_BREAKER_THRESHOLD,
  claimScheduleAttempt,
  failureBackoffMs,
  reconcileExpiredScheduleAttempts,
  recordScheduleFailure,
  recordScheduleSuccess,
  recordScheduleLifecycleFailure,
} from './health-store'

let scheduleId: string
let squadId: string
const base = new Date('2026-08-26T12:00:00.000Z')

beforeEach(async () => {
  const [squad] = await db
    .insert(squads)
    .values({ name: `health-${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  squadId = squad.id
  const [schedule] = await db
    .insert(schedules)
    .values({
      scopeType: 'squad',
      scopeId: squad.id,
      name: 'Health store test',
      schedule: { interval: '1h' },
      action: { type: 'create_work_stream', title: 'test' },
      nextTriggerAt: base,
    })
    .returning()
  scheduleId = schedule.id
})

afterEach(async () => {
  await db.delete(squads).where(eq(squads.id, squadId))
  await db.delete(schedules).where(eq(schedules.id, scheduleId))
})

async function claim(attemptedAt = base) {
  const attempt = await claimScheduleAttempt(scheduleId, { source: 'scheduled', attemptedAt, requireDue: true })
  expect(attempt).not.toBeNull()
  return attempt!
}

describe('schedule health transitions', () => {
  it('claims one leased attempt and fences concurrent claims and settlement', async () => {
    const attempt = await claim()
    expect(attempt).toMatchObject({ source: 'scheduled', attemptedAt: base })
    expect(attempt.leaseUntil.getTime()).toBe(base.getTime() + 15 * 60_000)
    await expect(claimScheduleAttempt(scheduleId, { source: 'manual', attemptedAt: base })).rejects.toMatchObject({
      code: 'attempt_in_progress',
    })
    await expect(
      recordScheduleSuccess(scheduleId, crypto.randomUUID(), new Date(base.getTime() + 1_000))
    ).rejects.toMatchObject({ code: 'attempt_in_progress' })
    await recordScheduleSuccess(scheduleId, attempt.id, new Date(base.getTime() + 1_000))
    const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
    expect(row).toMatchObject({ activeAttemptId: null, triggerCount: 1, failureCount: 0 })
    expect(row.lastSuccessAt).toEqual(new Date(base.getTime() + 1_000))
  })

  it('fences and settles an expired marker before a later claim may execute', async () => {
    const abandoned = await claim()
    const afterLease = new Date(abandoned.leaseUntil.getTime() + 1)
    const replay = await claimScheduleAttempt(scheduleId, { source: 'manual', attemptedAt: afterLease })
    expect(replay).toBeNull()
    const [settled] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
    expect(settled).toMatchObject({
      activeAttemptId: null,
      triggerCount: 1,
      failureCount: 1,
      lastErrorCode: 'execution_interrupted',
    })

    const retryAt = new Date(settled.nextTriggerAt!.getTime() + 1)
    const next = await claimScheduleAttempt(scheduleId, {
      source: 'manual',
      attemptedAt: retryAt,
    })
    expect(next).not.toBeNull()
    expect((await db.select().from(schedules).where(eq(schedules.id, scheduleId)))[0].triggerCount).toBe(2)
  })

  it('serializes concurrent claims racing an expired marker without replay', async () => {
    const abandoned = await claim()
    const afterLease = new Date(abandoned.leaseUntil.getTime() + 1)
    const results = await Promise.allSettled([
      claimScheduleAttempt(scheduleId, { source: 'manual', attemptedAt: afterLease }),
      claimScheduleAttempt(scheduleId, { source: 'webhook', attemptedAt: afterLease }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled' && result.value !== null)).toHaveLength(0)
    const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
    expect(row).toMatchObject({
      activeAttemptId: null,
      triggerCount: 1,
      failureCount: 1,
      lastErrorCode: 'execution_interrupted',
    })
  })

  it('atomically disables an expired schedule without recording an attempt or failure', async () => {
    await db
      .update(schedules)
      .set({ schedule: { interval: '1h', expiresAt: base.toISOString() } })
      .where(eq(schedules.id, scheduleId))
    expect(await claimScheduleAttempt(scheduleId, { source: 'manual', attemptedAt: base })).toBeNull()
    const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
    expect(row).toMatchObject({ enabled: false, webhookEnabled: false, triggerCount: 0, failureCount: 0 })
    expect(row.automaticallyDisabledAt).toEqual(base)
    const events = await db.select().from(scheduleHealthEvents).where(eq(scheduleHealthEvents.scheduleId, scheduleId))
    expect(events.map((event) => event.kind)).toEqual(['automatically_disabled'])
  })

  it('caps nominal next time at expiry and settles final success plus expiry together', async () => {
    const expiresAt = new Date(base.getTime() + 30 * 60_000)
    await db
      .update(schedules)
      .set({ schedule: { interval: '1h', expiresAt: expiresAt.toISOString() } })
      .where(eq(schedules.id, scheduleId))
    const attempt = await claim()
    expect((await db.select().from(schedules).where(eq(schedules.id, scheduleId)))[0].nextTriggerAt).toBeNull()
    const transitions = await recordScheduleSuccess(scheduleId, attempt.id, new Date(base.getTime() + 1_000))
    expect(transitions.map((transition) => transition.kind)).toEqual(['automatically_disabled'])
    const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
    expect(row).toMatchObject({ enabled: false, webhookEnabled: false, consecutiveFailureCount: 0 })
    expect(row.automaticallyDisabledAt).toEqual(new Date(base.getTime() + 1_000))
  })

  it('does not expire a successful one-shot before its future expiresAt', async () => {
    const expiresAt = new Date(base.getTime() + 24 * 60 * 60_000)
    await db
      .update(schedules)
      .set({
        schedule: { runAt: base.toISOString(), expiresAt: expiresAt.toISOString() },
        nextTriggerAt: base,
      })
      .where(eq(schedules.id, scheduleId))
    const attempt = await claim()
    const transitions = await recordScheduleSuccess(scheduleId, attempt.id, new Date(base.getTime() + 1_000))
    expect(transitions).toEqual([])
    const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
    expect(row.automaticallyDisabledAt).toBeNull()
    expect(row.automaticDisableReason).toBeNull()
  })

  it('does not retain the interrupted retry fence after recovery', async () => {
    const abandoned = await claim()
    const interruptedAt = new Date(abandoned.leaseUntil.getTime() + 1)
    expect(await claimScheduleAttempt(scheduleId, { source: 'manual', attemptedAt: interruptedAt })).toBeNull()
    const [failed] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
    const retry = await claimScheduleAttempt(scheduleId, {
      source: 'manual',
      attemptedAt: new Date(failed.nextTriggerAt!.getTime() + 1),
    })
    await recordScheduleSuccess(scheduleId, retry!.id, new Date(failed.nextTriggerAt!.getTime() + 2))
    const manual = await claimScheduleAttempt(scheduleId, {
      source: 'manual',
      attemptedAt: new Date(failed.nextTriggerAt!.getTime() + 3),
    })
    expect(manual).not.toBeNull()
  })

  it('immediately disables a permanent lifecycle failure while preserving an in-flight marker', async () => {
    const attempt = await claim()
    const transitions = await recordScheduleLifecycleFailure(
      scheduleId,
      {
        class: 'permanent',
        code: 'target_agent_terminated',
        summary: 'Target agent is terminated.',
      },
      new Date(base.getTime() + 1)
    )
    expect(transitions.map((transition) => transition.kind)).toEqual(['failed', 'automatically_disabled'])
    let [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
    expect(row).toMatchObject({ enabled: false, activeAttemptId: attempt.id, failureCount: 1 })
    expect(
      await recordScheduleFailure(
        scheduleId,
        attempt.id,
        {
          class: 'permanent',
          code: 'target_agent_terminated',
          summary: 'Target agent is terminated.',
        },
        new Date(base.getTime() + 2)
      )
    ).toEqual([])
    ;[row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
    expect(row).toMatchObject({ activeAttemptId: null, failureCount: 1 })
  })

  it('opens an incident, alerts at failure three, and applies exact bounded backoff', async () => {
    for (let consecutive = 1; consecutive <= 9; consecutive++) {
      const attemptedAt = new Date(base.getTime() + consecutive * 10_000)
      await db.update(schedules).set({ nextTriggerAt: attemptedAt, enabled: true }).where(eq(schedules.id, scheduleId))
      const attempt = await claim(attemptedAt)
      await recordScheduleFailure(
        scheduleId,
        attempt.id,
        { class: 'transient', code: 'transport_error', summary: 'A transport error interrupted the scheduled action.' },
        attemptedAt
      )
      const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
      expect(row.consecutiveFailureCount).toBe(consecutive)
      const delay = failureBackoffMs(consecutive)
      expect(row.nextTriggerAt!.getTime()).toBe(
        Math.max(attemptedAt.getTime() + 60 * 60_000, attemptedAt.getTime() + delay)
      )
    }
    const events = await db.select().from(scheduleHealthEvents).where(eq(scheduleHealthEvents.scheduleId, scheduleId))
    expect(events.filter((event) => event.kind === 'failed')).toHaveLength(9)
    const notifications = await db
      .select()
      .from(scheduleHealthNotifications)
      .where(eq(scheduleHealthNotifications.scheduleId, scheduleId))
    expect(notifications.map((notification) => notification.kind)).toEqual(['failure'])
    expect(failureBackoffMs(9)).toBe(60 * 60_000)
  })

  it('uses 30 seconds for initial one-shot retries then the approved exponential progression', async () => {
    await db
      .update(schedules)
      .set({ schedule: { runAt: base.toISOString() }, nextTriggerAt: base })
      .where(eq(schedules.id, scheduleId))
    let attemptedAt = base
    for (let count = 1; count <= 9; count++) {
      const attempt = await claimScheduleAttempt(scheduleId, { source: 'scheduled', attemptedAt, requireDue: true })
      await recordScheduleFailure(
        scheduleId,
        attempt!.id,
        {
          class: 'transient',
          code: 'transport_error',
          summary: 'A transport error interrupted the scheduled action.',
        },
        attemptedAt
      )
      const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
      const expectedDelay = Math.max(30_000, failureBackoffMs(count))
      expect(row.nextTriggerAt!.getTime()).toBe(attemptedAt.getTime() + expectedDelay)
      attemptedAt = row.nextTriggerAt!
    }
  })

  it('applies shared backoff to webhook failures on time-enabled schedules without replaying webhook-only actions', async () => {
    for (let count = 1; count <= 3; count++) {
      const failedAt = new Date(base.getTime() + count * 10_000)
      const attempt = await claimScheduleAttempt(scheduleId, { source: 'webhook', attemptedAt: failedAt })
      await recordScheduleFailure(
        scheduleId,
        attempt!.id,
        {
          class: 'transient',
          code: 'transport_error',
          summary: 'A transport error interrupted the scheduled action.',
        },
        failedAt
      )
    }
    const [timed] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
    expect(timed.nextTriggerAt!.getTime()).toBeGreaterThanOrEqual(base.getTime() + 30_000 + 60_000)

    await db
      .update(schedules)
      .set({
        schedule: {},
        nextTriggerAt: null,
        consecutiveFailureCount: 2,
        activeAttemptId: null,
        activeAttemptSource: null,
        activeAttemptStartedAt: null,
        activeAttemptLeaseUntil: null,
      })
      .where(eq(schedules.id, scheduleId))
    const webhookOnly = await claimScheduleAttempt(scheduleId, {
      source: 'webhook',
      attemptedAt: new Date(base.getTime() + 120_000),
    })
    await recordScheduleFailure(
      scheduleId,
      webhookOnly!.id,
      {
        class: 'transient',
        code: 'transport_error',
        summary: 'A transport error interrupted the scheduled action.',
      },
      new Date(base.getTime() + 120_000)
    )
    expect((await db.select().from(schedules).where(eq(schedules.id, scheduleId)))[0].nextTriggerAt).toBeNull()
  })

  it('applies the same third-failure backoff rule to manual and webhook attempts', async () => {
    for (const source of ['manual', 'webhook'] as const) {
      await db
        .update(schedules)
        .set({
          enabled: true,
          nextTriggerAt: base,
          failureCount: 0,
          consecutiveFailureCount: 0,
          lastFailureAt: null,
          lastErrorCode: null,
          lastErrorSummary: null,
          openFailureIncidentId: null,
        })
        .where(eq(schedules.id, scheduleId))
      for (let count = 1; count <= 3; count++) {
        const attemptedAt = new Date(base.getTime() + count * 10_000)
        const attempt = await claimScheduleAttempt(scheduleId, { source, attemptedAt })
        const nominal = (await db.select().from(schedules).where(eq(schedules.id, scheduleId)))[0].nextTriggerAt
        await recordScheduleFailure(
          scheduleId,
          attempt!.id,
          {
            class: 'transient',
            code: 'transport_error',
            summary: 'A transport error interrupted the scheduled action.',
          },
          attemptedAt
        )
        if (count === 3) {
          const boundary = (await db.select().from(schedules).where(eq(schedules.id, scheduleId)))[0].nextTriggerAt!
          expect(boundary.getTime()).toBe(Math.max(nominal?.getTime() ?? 0, attemptedAt.getTime() + 60_000))
        }
      }
    }
  })

  it('circuit-breaks at ten without duplicating milestones', async () => {
    for (let consecutive = 1; consecutive <= CIRCUIT_BREAKER_THRESHOLD; consecutive++) {
      const attemptedAt = new Date(base.getTime() + consecutive * 10_000)
      await db.update(schedules).set({ nextTriggerAt: attemptedAt, enabled: true }).where(eq(schedules.id, scheduleId))
      const attempt = await claim(attemptedAt)
      await recordScheduleFailure(
        scheduleId,
        attempt.id,
        { class: 'transient', code: 'transport_error', summary: 'A transport error interrupted the scheduled action.' },
        attemptedAt
      )
    }
    const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
    expect(row).toMatchObject({ enabled: false, webhookEnabled: false, consecutiveFailureCount: 10 })
    expect(row.automaticallyDisabledAt).not.toBeNull()
    expect(row.nextTriggerAt).toBeNull()
    const events = await db.select().from(scheduleHealthEvents).where(eq(scheduleHealthEvents.scheduleId, scheduleId))
    expect(events.filter((event) => event.kind === 'failed')).toHaveLength(10)
    expect(events.filter((event) => event.kind === 'automatically_disabled')).toHaveLength(1)
    const notifications = await db
      .select()
      .from(scheduleHealthNotifications)
      .where(eq(scheduleHealthNotifications.scheduleId, scheduleId))
    expect(notifications.map((notification) => notification.kind).sort()).toEqual(['disabled', 'failure'])
  })

  it('disables a permanent first failure and queues one combined notification', async () => {
    const attempt = await claim()
    await recordScheduleFailure(
      scheduleId,
      attempt.id,
      { class: 'permanent', code: 'target_agent_terminated', summary: 'Target agent is terminated.' },
      base
    )
    const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
    expect(row).toMatchObject({ enabled: false, failureCount: 1, consecutiveFailureCount: 1 })
    const notifications = await db
      .select()
      .from(scheduleHealthNotifications)
      .where(eq(scheduleHealthNotifications.scheduleId, scheduleId))
    expect(notifications.map((notification) => notification.kind)).toEqual(['permanent_failure'])
  })

  it('records recovery and only queues it for an escalated incident', async () => {
    for (let count = 1; count <= 3; count++) {
      const attemptedAt = new Date(base.getTime() + count * 10_000)
      await db.update(schedules).set({ nextTriggerAt: attemptedAt, enabled: true }).where(eq(schedules.id, scheduleId))
      const failed = await claim(attemptedAt)
      await recordScheduleFailure(
        scheduleId,
        failed.id,
        { class: 'transient', code: 'transport_error', summary: 'A transport error interrupted the scheduled action.' },
        attemptedAt
      )
    }
    const successAt = new Date(base.getTime() + 60_000)
    await db.update(schedules).set({ nextTriggerAt: successAt, enabled: true }).where(eq(schedules.id, scheduleId))
    const success = await claim(successAt)
    await recordScheduleSuccess(scheduleId, success.id, successAt)
    const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
    expect(row).toMatchObject({ consecutiveFailureCount: 0, openFailureIncidentId: null })
    expect(row.lastRecoveredAt).toEqual(successAt)
    const notifications = await db
      .select()
      .from(scheduleHealthNotifications)
      .where(eq(scheduleHealthNotifications.scheduleId, scheduleId))
    expect(notifications.map((notification) => notification.kind).sort()).toEqual(['failure', 'recovery'])
  })

  it('settles expired attempt leases as interrupted transient failures', async () => {
    const attempt = await claim()
    const transitions = await reconcileExpiredScheduleAttempts(new Date(attempt.leaseUntil.getTime() + 1))
    expect(transitions).toHaveLength(1)
    const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId))
    expect(row).toMatchObject({ activeAttemptId: null, failureCount: 1, lastErrorCode: 'execution_interrupted' })
  })
})
