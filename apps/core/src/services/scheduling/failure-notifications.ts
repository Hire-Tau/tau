import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, scheduleHealthEvents, scheduleHealthNotifications, schedules, squads } from '../../db/schema'
import { InboxMessage } from '../../entities/InboxMessage'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('schedule-health-notifier')
const MAX_CLAIM_LIMIT = 100

export interface ScheduleHealthNotificationClaim {
  notificationId: string
  scheduleId: string
  eventId: string
  incidentId: string
  kind: 'failure' | 'permanent_failure' | 'disabled' | 'recovery'
  idempotencyKey: string
  claimToken: string
  attempts: number
  squadId: string | null
  scheduleName: string
  scopeType: 'squad' | 'agent'
  scopeId: string
  errorCode: string | null
  errorSummary: string | null
  consecutiveFailureCount: number | null
}

interface Candidate extends Record<string, unknown> {
  id: string
}

export async function claimDueScheduleHealthNotifications(input: {
  now: Date
  limit?: number
}): Promise<ScheduleHealthNotificationClaim[]> {
  const limit = input.limit ?? 32
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLAIM_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_CLAIM_LIMIT}`)
  }
  const now = input.now.toISOString()
  return db.transaction(async (tx) => {
    const candidates = await tx.execute<Candidate>(sql`
      SELECT notification.id
      FROM schedule_health_notifications AS notification
      WHERE notification.next_attempt_at <= ${now}::timestamp
        AND (
          notification.status = 'pending'
          OR (
            notification.status = 'delivering'
            AND notification.claimed_at + interval '60 seconds' <= ${now}::timestamp
          )
        )
        AND (
          notification.kind <> 'recovery'
          OR EXISTS (
            SELECT 1
            FROM schedule_health_notifications AS escalation
            WHERE escalation.incident_id = notification.incident_id
              AND escalation.kind IN ('failure', 'permanent_failure', 'disabled')
              AND escalation.status = 'delivered'
          )
        )
      ORDER BY notification.created_at, notification.id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `)
    if (candidates.length === 0) return []

    const claimed = await tx
      .update(scheduleHealthNotifications)
      .set({
        status: 'delivering',
        claimToken: sql`gen_random_uuid()`,
        claimedAt: input.now,
        attempts: sql`${scheduleHealthNotifications.attempts} + 1`,
        updatedAt: input.now,
      })
      .where(
        inArray(
          scheduleHealthNotifications.id,
          candidates.map((candidate) => candidate.id)
        )
      )
      .returning({ id: scheduleHealthNotifications.id })

    const rows = await tx
      .select({
        notificationId: scheduleHealthNotifications.id,
        scheduleId: scheduleHealthNotifications.scheduleId,
        eventId: scheduleHealthNotifications.eventId,
        incidentId: scheduleHealthNotifications.incidentId,
        kind: scheduleHealthNotifications.kind,
        idempotencyKey: scheduleHealthNotifications.idempotencyKey,
        claimToken: scheduleHealthNotifications.claimToken,
        attempts: scheduleHealthNotifications.attempts,
        squadId: scheduleHealthNotifications.squadId,
        scheduleName: schedules.name,
        scopeType: schedules.scopeType,
        scopeId: schedules.scopeId,
        errorCode: scheduleHealthEvents.errorCode,
        errorSummary: scheduleHealthEvents.errorSummary,
        consecutiveFailureCount: scheduleHealthEvents.consecutiveFailureCount,
      })
      .from(scheduleHealthNotifications)
      .innerJoin(schedules, eq(schedules.id, scheduleHealthNotifications.scheduleId))
      .innerJoin(scheduleHealthEvents, eq(scheduleHealthEvents.id, scheduleHealthNotifications.eventId))
      .where(
        inArray(
          scheduleHealthNotifications.id,
          claimed.map((row) => row.id)
        )
      )

    return rows.map((row) => {
      if (!row.claimToken) throw new Error(`Claimed schedule health notification ${row.notificationId} has no token`)
      return { ...row, claimToken: row.claimToken }
    })
  })
}

async function resolveCurrentManager(claim: ScheduleHealthNotificationClaim) {
  let squadId: string | null
  if (claim.scopeType === 'squad') {
    squadId = claim.scopeId
  } else {
    const [scopedAgent] = await db.select({ squadId: agents.squadId }).from(agents).where(eq(agents.id, claim.scopeId))
    squadId = scopedAgent ? scopedAgent.squadId : claim.squadId
  }
  if (!squadId) throw new Error('Schedule scope has no current squad manager route')
  const [squad] = await db.select().from(squads).where(eq(squads.id, squadId))
  if (!squad || squad.archivedAt || !squad.managerAgentId) throw new Error('Schedule scope has no current manager')
  const [manager] = await db.select().from(agents).where(eq(agents.id, squad.managerAgentId))
  if (!manager || manager.status === 'terminated') throw new Error('Schedule scope manager is unavailable')
  return { manager, squad }
}

function subjectFor(claim: ScheduleHealthNotificationClaim): string {
  if (claim.kind === 'recovery') return `Schedule recovered: ${claim.scheduleName}`
  if (claim.kind === 'failure') return `Schedule failing: ${claim.scheduleName}`
  return `Schedule automatically disabled: ${claim.scheduleName}`
}

function contentFor(claim: ScheduleHealthNotificationClaim): string {
  if (claim.kind === 'recovery') return `The schedule “${claim.scheduleName}” has recovered after an escalated failure.`
  const count = claim.consecutiveFailureCount == null ? '' : `\nConsecutive failures: ${claim.consecutiveFailureCount}`
  const code = claim.errorCode ? `\nError code: ${claim.errorCode}` : ''
  const summary = claim.errorSummary ?? 'The scheduled action failed.'
  return `The schedule “${claim.scheduleName}” requires attention.${count}${code}\nSummary: ${summary}`.slice(0, 2_000)
}

async function markDelivered(claim: ScheduleHealthNotificationClaim, inboxMessageId: string, now: Date): Promise<void> {
  await db
    .update(scheduleHealthNotifications)
    .set({
      status: 'delivered',
      inboxMessageId,
      deliveredAt: now,
      claimToken: null,
      claimedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduleHealthNotifications.id, claim.notificationId),
        eq(scheduleHealthNotifications.status, 'delivering'),
        eq(scheduleHealthNotifications.claimToken, claim.claimToken)
      )
    )
}

async function retryLater(claim: ScheduleHealthNotificationClaim, now: Date): Promise<void> {
  const delay = Math.min(60_000 * 2 ** Math.max(0, claim.attempts - 1), 60 * 60_000)
  await db
    .update(scheduleHealthNotifications)
    .set({
      status: 'pending',
      nextAttemptAt: new Date(now.getTime() + delay),
      claimToken: null,
      claimedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduleHealthNotifications.id, claim.notificationId),
        eq(scheduleHealthNotifications.status, 'delivering'),
        eq(scheduleHealthNotifications.claimToken, claim.claimToken)
      )
    )
}

export interface ScheduleHealthNotifierAdapter {
  afterSendOnce?: (input: { claim: ScheduleHealthNotificationClaim; inboxMessageId: string }) => Promise<void>
}

export class ScheduleHealthNotifier {
  constructor(private readonly adapter: ScheduleHealthNotifierAdapter = {}) {}

  async drain(input: { now: Date; limit?: number }): Promise<void> {
    const claims = await claimDueScheduleHealthNotifications(input)
    await Promise.all(claims.map((claim) => this.deliver(claim, input.now)))
  }

  private async deliver(claim: ScheduleHealthNotificationClaim, now: Date): Promise<void> {
    let inboxMessageId: string
    try {
      const { manager, squad } = await resolveCurrentManager(claim)
      const result = await InboxMessage.sendOnce(
        {
          recipientType: 'agent',
          recipientId: manager.id,
          senderType: 'system',
          wakeEligible: true,
          subject: subjectFor(claim),
          content: contentFor(claim),
          metadata: {
            source: 'schedule-health',
            scheduleId: claim.scheduleId,
            healthEventId: claim.eventId,
            incidentId: claim.incidentId,
            phase: claim.kind,
            squadId: squad.id,
          },
        },
        claim.idempotencyKey
      )
      inboxMessageId = result.message.id
    } catch (error) {
      log.warn(`Schedule health notification ${claim.notificationId} remains pending`, error)
      await retryLater(claim, now)
      return
    }
    // Deliberately outside the retry catch: this seam models a process crash
    // after sendOnce but before outbox settlement, leaving the lease reclaimable.
    await this.adapter.afterSendOnce?.({ claim, inboxMessageId })
    await markDelivered(claim, inboxMessageId, now)
  }

  drainSoon(): void {
    queueMicrotask(() => {
      void this.drain({ now: new Date() }).catch((error) =>
        log.error('Schedule health notification drain failed', error)
      )
    })
  }
}

export const scheduleHealthNotifier = new ScheduleHealthNotifier()
