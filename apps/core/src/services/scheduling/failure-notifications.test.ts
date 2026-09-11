import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { db } from '../../db'
import { agents, inbox, scheduleHealthNotifications, schedules, squads } from '../../db/schema'
import { InboxMessage } from '../../entities/InboxMessage'
import { and, eq } from 'drizzle-orm'
import { claimScheduleAttempt, recordScheduleFailure, recordScheduleSuccess } from './health-store'
import { ScheduleHealthNotifier } from './failure-notifications'

let squadId: string
let scheduleId: string
let managerOneId: string
let managerTwoId: string
const base = new Date('2026-08-26T12:00:00.000Z')

beforeEach(async () => {
  const [squad] = await db
    .insert(squads)
    .values({ name: `notify-${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  squadId = squad.id
  const [managerOne] = await db.insert(agents).values({ agentTypeId: 'manager', squadId }).returning()
  const [managerTwo] = await db.insert(agents).values({ agentTypeId: 'manager', squadId }).returning()
  managerOneId = managerOne.id
  managerTwoId = managerTwo.id
  await db.update(squads).set({ managerAgentId: managerOne.id }).where(eq(squads.id, squadId))
  const [schedule] = await db
    .insert(schedules)
    .values({
      scopeType: 'squad',
      scopeId: squadId,
      name: 'Failing schedule',
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: crypto.randomUUID() }, content: 'x' },
      nextTriggerAt: base,
    })
    .returning()
  scheduleId = schedule.id
})

afterEach(async () => {
  await db.delete(schedules).where(eq(schedules.id, scheduleId))
  await db.delete(squads).where(eq(squads.id, squadId))
})

async function queueEscalatedFailure() {
  for (let count = 1; count <= 3; count++) {
    const attemptedAt = new Date(base.getTime() + count * 10_000)
    await db.update(schedules).set({ enabled: true, nextTriggerAt: attemptedAt }).where(eq(schedules.id, scheduleId))
    const attempt = await claimScheduleAttempt(scheduleId, { source: 'scheduled', attemptedAt, requireDue: true })
    await recordScheduleFailure(
      scheduleId,
      attempt!.id,
      { class: 'transient', code: 'transport_error', summary: 'A transport error interrupted the scheduled action.' },
      attemptedAt
    )
  }
}

describe('ScheduleHealthNotifier', () => {
  it('concurrent drains deliver one safe message to the current manager, not the action target', async () => {
    await queueEscalatedFailure()
    await db.update(squads).set({ managerAgentId: managerTwoId }).where(eq(squads.id, squadId))
    const notifier = new ScheduleHealthNotifier()
    await Promise.all([
      notifier.drain({ now: new Date(base.getTime() + 60_000) }),
      notifier.drain({ now: new Date(base.getTime() + 60_000) }),
    ])

    const currentManagerInbox = await InboxMessage.listForRecipient('agent', managerTwoId, { includeRead: true })
    expect(currentManagerInbox).toHaveLength(1)
    expect(currentManagerInbox[0].metadata).toMatchObject({ source: 'schedule-health', scheduleId, phase: 'failure' })
    expect(currentManagerInbox[0].content).toContain('A transport error interrupted the scheduled action.')
    expect(currentManagerInbox[0].content).not.toContain('target')
    expect(await InboxMessage.listForRecipient('agent', managerOneId, { includeRead: true })).toHaveLength(0)
    const rows = await db
      .select()
      .from(scheduleHealthNotifications)
      .where(eq(scheduleHealthNotifications.scheduleId, scheduleId))
    expect(rows[0]).toMatchObject({ status: 'delivered', attempts: 1 })
  })

  it('resolves an agent-scoped schedule manager after the agent moves squads', async () => {
    const [scopedAgent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId }).returning()
    await db.update(schedules).set({ scopeType: 'agent', scopeId: scopedAgent.id }).where(eq(schedules.id, scheduleId))
    await queueEscalatedFailure()
    const [newSquad] = await db
      .insert(squads)
      .values({ name: `moved-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    const [newManager] = await db.insert(agents).values({ agentTypeId: 'manager', squadId: newSquad.id }).returning()
    await db.update(squads).set({ managerAgentId: newManager.id }).where(eq(squads.id, newSquad.id))
    await db.update(agents).set({ squadId: newSquad.id }).where(eq(agents.id, scopedAgent.id))
    try {
      await new ScheduleHealthNotifier().drain({ now: new Date(base.getTime() + 60_000) })
      expect(await InboxMessage.listForRecipient('agent', newManager.id, { includeRead: true })).toHaveLength(1)
      expect(await InboxMessage.listForRecipient('agent', managerOneId, { includeRead: true })).toHaveLength(0)
    } finally {
      await db.delete(schedules).where(eq(schedules.id, scheduleId))
      await db.delete(squads).where(eq(squads.id, newSquad.id))
    }
  })

  it('reclaims a crash-after-sendOnce lease, adopts the message, and fences stale settlement', async () => {
    await queueEscalatedFailure()
    const deliveryAt = new Date(base.getTime() + 60_000)
    let staleClaim: import('./failure-notifications').ScheduleHealthNotificationClaim | undefined
    const crashing = new ScheduleHealthNotifier({
      afterSendOnce: async ({ claim }) => {
        staleClaim = claim
        throw new Error('simulated process crash')
      },
    })
    await expect(crashing.drain({ now: deliveryAt })).rejects.toThrow('simulated process crash')
    let [row] = await db
      .select()
      .from(scheduleHealthNotifications)
      .where(eq(scheduleHealthNotifications.scheduleId, scheduleId))
    expect(row).toMatchObject({ status: 'delivering', attempts: 1 })
    expect(await InboxMessage.listForRecipient('agent', managerOneId, { includeRead: true })).toHaveLength(1)

    const reclaimAt = new Date(deliveryAt.getTime() + 61_000)
    const notifier = new ScheduleHealthNotifier({
      afterSendOnce: async ({ claim }) => {
        expect(claim.claimToken).not.toBe(staleClaim!.claimToken)
        const staleSettlement = await db
          .update(scheduleHealthNotifications)
          .set({ status: 'delivered' })
          .where(
            and(
              eq(scheduleHealthNotifications.id, staleClaim!.notificationId),
              eq(scheduleHealthNotifications.status, 'delivering'),
              eq(scheduleHealthNotifications.claimToken, staleClaim!.claimToken)
            )
          )
          .returning()
        expect(staleSettlement).toHaveLength(0)
      },
    })
    await notifier.drain({ now: reclaimAt })
    ;[row] = await db
      .select()
      .from(scheduleHealthNotifications)
      .where(eq(scheduleHealthNotifications.scheduleId, scheduleId))
    expect(row).toMatchObject({ status: 'delivered', attempts: 2 })
    expect(await InboxMessage.listForRecipient('agent', managerOneId, { includeRead: true })).toHaveLength(1)

    const retryAt = new Date(
      (await db.select().from(schedules).where(eq(schedules.id, scheduleId)))[0].nextTriggerAt!.getTime() + 1
    )
    await db.update(schedules).set({ enabled: true, nextTriggerAt: retryAt }).where(eq(schedules.id, scheduleId))
    const attempt = await claimScheduleAttempt(scheduleId, {
      source: 'scheduled',
      attemptedAt: retryAt,
      requireDue: true,
    })
    await recordScheduleSuccess(scheduleId, attempt!.id, retryAt)
    await notifier.drain({ now: new Date(retryAt.getTime() + 1) })
    const messages = await InboxMessage.listForRecipient('agent', managerOneId, { includeRead: true })
    expect(messages.map((message) => (message.metadata as Record<string, unknown>).phase)).toEqual([
      'recovery',
      'failure',
    ])
    expect(messages[1].createdAt.getTime()).toBeLessThanOrEqual(messages[0].createdAt.getTime())
  })

  it('uses the snapshotted squad when an agent-scoped schedule owner was deleted', async () => {
    const [scopedAgent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId }).returning()
    await db.update(schedules).set({ scopeType: 'agent', scopeId: scopedAgent.id }).where(eq(schedules.id, scheduleId))
    await queueEscalatedFailure()
    await db.delete(agents).where(eq(agents.id, scopedAgent.id))
    await new ScheduleHealthNotifier().drain({ now: new Date(base.getTime() + 60_000) })
    expect(await InboxMessage.listForRecipient('agent', managerOneId, { includeRead: true })).toHaveLength(1)
  })

  it('keeps delivery pending with bounded retry when the manager is missing', async () => {
    await queueEscalatedFailure()
    await db.update(squads).set({ managerAgentId: null }).where(eq(squads.id, squadId))
    await new ScheduleHealthNotifier().drain({ now: new Date(base.getTime() + 60_000) })
    const [row] = await db
      .select()
      .from(scheduleHealthNotifications)
      .where(eq(scheduleHealthNotifications.scheduleId, scheduleId))
    expect(row.status).toBe('pending')
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(base.getTime() + 60_000)
    expect(await db.select().from(inbox).where(eq(inbox.recipientId, managerOneId))).toHaveLength(0)
  })
})
