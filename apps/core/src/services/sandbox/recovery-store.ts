import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db as defaultDb } from '../../db'
import { agents, sandboxRecoveryEpisodes, sandboxRecoverySubscriptions } from '../../db/schema'
import { META_COUNT } from './restart/types'

const RECOVERY_EPISODE_LOCK_NAMESPACE = 1_730_921_441
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SANDBOX_ID_PATTERN = /^(?:agent|squad|system_manager)_[A-Za-z0-9-]+$/

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

function isSandboxId(value: string): boolean {
  return value.length <= 255 && SANDBOX_ID_PATTERN.test(value)
}

type Database = typeof defaultDb
export type RecoveryOutcome = 'recovered' | 'gave_up'
export type RecoveryNotificationKind = 'recovered' | 'still_unavailable'
export const RECOVERY_DELIVERY_LEASE_MS = 60_000

export interface RecoveryRegistration {
  episodeId: string
  sandboxId: string
  generation: number
  startedAt: Date
  crashChargeWinner: boolean
  crashCount?: number
}

export class SandboxRecoveryStore {
  constructor(private readonly db: Database = defaultDb) {}

  async register(input: {
    agentId: string
    sandboxIds: string[]
    reason?: string
    crash?: boolean
    observedAt?: Date
  }): Promise<{ registrations: RecoveryRegistration[] }> {
    if (!isUuid(input.agentId)) throw new TypeError('Invalid recovery agent ID')
    if (input.sandboxIds.some((sandboxId) => !isSandboxId(sandboxId))) {
      throw new TypeError('Invalid recovery sandbox ID')
    }
    const sandboxIds = [...new Set(input.sandboxIds)].sort()
    const observedAt = input.observedAt ?? new Date()
    return this.db.transaction(async (tx) => {
      if (input.crash) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sandbox-recovery-agent:${input.agentId}`}))`)
      }
      const registrations: RecoveryRegistration[] = []
      let crashCharged = false
      for (const sandboxId of sandboxIds) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${RECOVERY_EPISODE_LOCK_NAMESPACE}, hashtext(${sandboxId}))`)
        let [episode] = await tx
          .select()
          .from(sandboxRecoveryEpisodes)
          .where(and(eq(sandboxRecoveryEpisodes.sandboxId, sandboxId), isNull(sandboxRecoveryEpisodes.endedAt)))
          .limit(1)
        if (!episode) {
          const [latest] = await tx
            .select({
              id: sandboxRecoveryEpisodes.id,
              generation: sandboxRecoveryEpisodes.generation,
              endedAt: sandboxRecoveryEpisodes.endedAt,
            })
            .from(sandboxRecoveryEpisodes)
            .where(eq(sandboxRecoveryEpisodes.sandboxId, sandboxId))
            .orderBy(desc(sandboxRecoveryEpisodes.generation))
            .limit(1)
          if (latest?.endedAt && latest.endedAt.getTime() >= observedAt.getTime()) {
            ;[episode] = await tx
              .select()
              .from(sandboxRecoveryEpisodes)
              .where(eq(sandboxRecoveryEpisodes.id, latest.id))
          } else {
            ;[episode] = await tx
              .insert(sandboxRecoveryEpisodes)
              .values({
                sandboxId,
                generation: (latest?.generation ?? 0) + 1,
                reason: input.reason,
                startedAt: observedAt,
              })
              .returning()
          }
        }

        await tx
          .insert(sandboxRecoverySubscriptions)
          .values({ episodeId: episode.id, agentId: input.agentId })
          .onConflictDoNothing()

        let crashChargeWinner = false
        let crashCount: number | undefined
        if (input.crash && !crashCharged) {
          const [alreadyCharged] = await tx
            .select({ episodeId: sandboxRecoverySubscriptions.episodeId })
            .from(sandboxRecoverySubscriptions)
            .innerJoin(sandboxRecoveryEpisodes, eq(sandboxRecoveryEpisodes.id, sandboxRecoverySubscriptions.episodeId))
            .where(
              and(
                eq(sandboxRecoverySubscriptions.agentId, input.agentId),
                eq(sandboxRecoverySubscriptions.crashCharged, true),
                isNull(sandboxRecoveryEpisodes.endedAt)
              )
            )
            .limit(1)
          crashCharged = Boolean(alreadyCharged)
          if (!crashCharged) {
            const [updatedAgent] = await tx
              .update(agents)
              .set({
                metadata: sql`coalesce(${agents.metadata}, '{}'::jsonb) || jsonb_build_object(
                  'sandboxRestartCount', CASE
                    WHEN (${agents.metadata}->>'sandboxRestartCount') ~ '^[0-9]+$'
                      THEN (${agents.metadata}->>'sandboxRestartCount')::integer
                    ELSE 0
                  END + 1,
                  'lastSandboxRestartAt', ${observedAt.getTime()}::bigint
                )`,
                updatedAt: observedAt,
              })
              .where(eq(agents.id, input.agentId))
              .returning({ metadata: agents.metadata })
            if (!updatedAgent) throw new Error(`Agent ${input.agentId} not found while charging crash budget`)
            crashCount = Number((updatedAgent.metadata as Record<string, unknown> | null)?.[META_COUNT] ?? 0)
            await tx
              .update(sandboxRecoverySubscriptions)
              .set({ crashCharged: true, updatedAt: observedAt })
              .where(
                and(
                  eq(sandboxRecoverySubscriptions.episodeId, episode.id),
                  eq(sandboxRecoverySubscriptions.agentId, input.agentId)
                )
              )
            crashCharged = true
            crashChargeWinner = true
          }
        }
        registrations.push({
          episodeId: episode.id,
          sandboxId,
          generation: episode.generation,
          startedAt: episode.startedAt,
          crashChargeWinner,
          crashCount,
        })
      }
      return { registrations }
    })
  }

  async hasClosedEpisode(sandboxId: string): Promise<boolean> {
    if (!isSandboxId(sandboxId)) return false
    const [episode] = await this.db
      .select({ id: sandboxRecoveryEpisodes.id })
      .from(sandboxRecoveryEpisodes)
      .where(and(eq(sandboxRecoveryEpisodes.sandboxId, sandboxId), sql`${sandboxRecoveryEpisodes.endedAt} IS NOT NULL`))
      .limit(1)
    return Boolean(episode)
  }

  async listWatching(filters: { agentId?: string; sandboxId?: string } = {}) {
    if (filters.agentId && !isUuid(filters.agentId)) return []
    if (filters.sandboxId && !isSandboxId(filters.sandboxId)) return []
    return this.db
      .select({
        episodeId: sandboxRecoveryEpisodes.id,
        agentId: sandboxRecoverySubscriptions.agentId,
        sandboxId: sandboxRecoveryEpisodes.sandboxId,
        startedAt: sandboxRecoveryEpisodes.startedAt,
        reason: sandboxRecoveryEpisodes.reason,
        crashCharged: sandboxRecoverySubscriptions.crashCharged,
      })
      .from(sandboxRecoverySubscriptions)
      .innerJoin(sandboxRecoveryEpisodes, eq(sandboxRecoveryEpisodes.id, sandboxRecoverySubscriptions.episodeId))
      .where(
        and(
          eq(sandboxRecoverySubscriptions.status, 'watching'),
          filters.agentId ? eq(sandboxRecoverySubscriptions.agentId, filters.agentId) : undefined,
          filters.sandboxId ? eq(sandboxRecoveryEpisodes.sandboxId, filters.sandboxId) : undefined
        )
      )
  }

  async isWatched(agentId: string): Promise<boolean> {
    if (!isUuid(agentId)) return false
    const [row] = await this.db
      .select({ episodeId: sandboxRecoverySubscriptions.episodeId })
      .from(sandboxRecoverySubscriptions)
      .where(
        and(
          eq(sandboxRecoverySubscriptions.agentId, agentId),
          sql`${sandboxRecoverySubscriptions.status} IN ('watching', 'pending', 'delivering')`
        )
      )
      .limit(1)
    return Boolean(row)
  }

  async prepareNotification(input: {
    episodeId: string
    agentId: string
    kind: RecoveryNotificationKind
    content: string
    recordOnly: boolean
    now?: Date
  }) {
    if (!isUuid(input.episodeId) || !isUuid(input.agentId)) return undefined
    const now = input.now ?? new Date()
    return this.db.transaction(async (tx) => {
      const [episode] = await tx
        .select({ sandboxId: sandboxRecoveryEpisodes.sandboxId })
        .from(sandboxRecoveryEpisodes)
        .where(eq(sandboxRecoveryEpisodes.id, input.episodeId))
      if (!episode) return undefined
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${RECOVERY_EPISODE_LOCK_NAMESPACE}, hashtext(${episode.sandboxId}))`
      )
      const updated = await tx
        .update(sandboxRecoverySubscriptions)
        .set({
          status: 'pending',
          notificationKind: input.kind,
          notificationClientId: `sandbox-recovery:${input.agentId}:${input.episodeId}:${input.kind}`,
          content: input.content,
          recordOnly: input.recordOnly,
          updatedAt: now,
        })
        .where(
          and(
            eq(sandboxRecoverySubscriptions.episodeId, input.episodeId),
            eq(sandboxRecoverySubscriptions.agentId, input.agentId),
            eq(sandboxRecoverySubscriptions.status, 'watching')
          )
        )
        .returning()
      if (updated[0]) {
        await tx
          .update(sandboxRecoveryEpisodes)
          .set({ endedAt: now, outcome: input.kind === 'recovered' ? 'recovered' : 'gave_up' })
          .where(and(eq(sandboxRecoveryEpisodes.id, input.episodeId), isNull(sandboxRecoveryEpisodes.endedAt)))
        return updated[0]
      }
      const [existing] = await tx
        .select()
        .from(sandboxRecoverySubscriptions)
        .where(
          and(
            eq(sandboxRecoverySubscriptions.episodeId, input.episodeId),
            eq(sandboxRecoverySubscriptions.agentId, input.agentId)
          )
        )
      return existing
    })
  }

  async claimDue(input: { agentId?: string; now?: Date; limit?: number } = {}) {
    if (input.agentId && !isUuid(input.agentId)) return []
    const now = input.now ?? new Date()
    const staleBefore = new Date(now.getTime() - RECOVERY_DELIVERY_LEASE_MS)
    const rows = (await this.db.execute(sql`
      WITH candidates AS (
        SELECT episode_id, agent_id
        FROM sandbox_recovery_subscriptions
        WHERE (${input.agentId ?? null}::uuid IS NULL OR agent_id = ${input.agentId ?? null}::uuid)
          AND (status = 'pending' OR (status = 'delivering' AND claimed_at <= ${staleBefore.toISOString()}))
        ORDER BY created_at, episode_id, agent_id
        LIMIT ${input.limit ?? 32}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE sandbox_recovery_subscriptions s
      SET status = 'delivering', claim_token = gen_random_uuid(), claimed_at = ${now.toISOString()},
          attempts = s.attempts + 1, updated_at = ${now.toISOString()}
      FROM candidates c
      WHERE s.episode_id = c.episode_id AND s.agent_id = c.agent_id
      RETURNING s.*, (SELECT e.sandbox_id FROM sandbox_recovery_episodes e WHERE e.id = s.episode_id) AS sandbox_id
    `)) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      episodeId: String(row.episode_id),
      agentId: String(row.agent_id),
      claimToken: String(row.claim_token),
      sandboxId: String(row.sandbox_id),
      notificationKind: row.notification_kind as RecoveryNotificationKind,
      content: String(row.content),
      recordOnly: Boolean(row.record_only),
    }))
  }

  async markDelivered(
    episodeId: string,
    agentId: string,
    claimToken: string,
    delivery?: { messageId?: string; executionId?: string }
  ): Promise<boolean> {
    if (!isUuid(episodeId) || !isUuid(agentId) || !isUuid(claimToken)) return false
    const rows = await this.db
      .update(sandboxRecoverySubscriptions)
      .set({
        status: 'delivered',
        deliveryMessageId: delivery?.messageId,
        deliveryExecutionId: delivery?.executionId,
        deliveredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sandboxRecoverySubscriptions.episodeId, episodeId),
          eq(sandboxRecoverySubscriptions.agentId, agentId),
          eq(sandboxRecoverySubscriptions.status, 'delivering'),
          eq(sandboxRecoverySubscriptions.claimToken, claimToken)
        )
      )
      .returning({ episodeId: sandboxRecoverySubscriptions.episodeId })
    return rows.length === 1
  }

  async closeEpisode(episodeId: string, outcome: RecoveryOutcome, endedAt: Date = new Date()): Promise<boolean> {
    if (!isUuid(episodeId)) return false
    const rows = await this.db
      .update(sandboxRecoveryEpisodes)
      .set({ outcome, endedAt })
      .where(and(eq(sandboxRecoveryEpisodes.id, episodeId), isNull(sandboxRecoveryEpisodes.endedAt)))
      .returning({ id: sandboxRecoveryEpisodes.id })
    return rows.length === 1
  }
}
