import { createHash } from 'crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db as defaultDb } from '../../../db'
import { sandboxProvisionRecoveries } from '../../../db/schema'

export const PROVISION_RECOVERY_BATCH_SIZE = 8
export const PROVISION_RECOVERY_LEASE_MS = 30_000
export const PROVISION_RECOVERY_MAX_ATTEMPTS = 8
export const PROVISION_RECOVERY_DEADLINE_MS = 15 * 60_000

export function deterministicRecoveryJitter(
  executionId: string,
  generation: number,
  attemptCount: number,
  maxJitterMs: number
): number {
  if (maxJitterMs <= 0) return 0
  const digest = createHash('sha256').update(`${executionId}:${generation}:${attemptCount}`).digest()
  return digest.readUInt32BE(0) % (Math.floor(maxJitterMs) + 1)
}

export function computeProvisionRecoveryTiming(input: {
  executionId: string
  generation: number
  attemptCount: number
  retryAfterMs?: number
  now: Date
  deadlineAt: Date
}): { delayMs: number; nextAttemptAt: Date } {
  const exponential = Math.min(5_000 * 2 ** input.attemptCount, 60_000)
  const base = Math.max(input.retryAfterMs ?? 0, exponential)
  const jitter = deterministicRecoveryJitter(
    input.executionId,
    input.generation,
    input.attemptCount,
    Math.floor(base * 0.2)
  )
  const desired = base + jitter
  const remaining = Math.max(0, input.deadlineAt.getTime() - input.now.getTime())
  const delayMs = Math.min(desired, remaining)
  return { delayMs, nextAttemptAt: new Date(input.now.getTime() + delayMs) }
}

export type ProvisionRecoveryClaimKind = 'ordinary' | 'half_open_probe'

export interface ProvisionRecoveryLease {
  executionId: string
  agentId: string
  workStreamId: string | null
  scope: string
  sandboxKey: string
  generation: number
  attemptCount: number
  deadlineAt: Date
  leaseOwner: string
  leaseExpiresAt: Date
  claimKind: ProvisionRecoveryClaimKind
}

type Database = typeof defaultDb

/** Durable, generation-fenced leases for sandbox recovery subscribers. */
export class PostgresProvisionRecoveryStore {
  constructor(private readonly db: Database = defaultDb) {}

  async releaseLease(lease: ProvisionRecoveryLease, nextAttemptAt: Date, now: Date = new Date()): Promise<boolean> {
    const rows = await this.db
      .update(sandboxProvisionRecoveries)
      .set({
        status: 'waiting',
        nextAttemptAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        claimKind: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(sandboxProvisionRecoveries.executionId, lease.executionId),
          eq(sandboxProvisionRecoveries.generation, lease.generation),
          eq(sandboxProvisionRecoveries.leaseOwner, lease.leaseOwner),
          eq(sandboxProvisionRecoveries.status, 'leased')
        )
      )
      .returning({ executionId: sandboxProvisionRecoveries.executionId })
    return rows.length === 1
  }

  async claimDue(ownerId: string, now: Date = new Date()): Promise<ProvisionRecoveryLease[]> {
    const leaseExpiresAt = new Date(now.getTime() + PROVISION_RECOVERY_LEASE_MS)
    return this.db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        WITH eligible AS MATERIALIZED (
          SELECT r.*, c.state AS control_state, c.retry_at AS control_retry_at
          FROM sandbox_provision_recoveries r
          JOIN k8s_provision_controls c ON c.scope = r.scope
          WHERE (
              (r.status = 'waiting' AND r.next_attempt_at <= ${now.toISOString()})
              OR (r.status = 'leased' AND r.lease_expires_at <= ${now.toISOString()})
            )
            AND c.state <> 'half_open'
            AND (
              c.state = 'closed'
              OR (c.state = 'open' AND c.retry_at <= ${now.toISOString()})
            )
        ), lockable AS (
          SELECT eligible.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY eligible.scope, eligible.sandbox_key
                   ORDER BY eligible.attempt_count, eligible.next_attempt_at, eligible.created_at, eligible.execution_id
                 ) AS sandbox_rank,
                 ROW_NUMBER() OVER (
                   PARTITION BY eligible.scope
                   ORDER BY eligible.attempt_count, eligible.next_attempt_at, eligible.created_at, eligible.execution_id
                 ) AS scope_rank
          FROM eligible
        ), candidates AS (
          SELECT l.execution_id,
                 CASE WHEN l.control_state = 'open' THEN 'half_open_probe' ELSE 'ordinary' END AS claim_kind
          FROM lockable l
          WHERE l.sandbox_rank = 1
            AND NOT EXISTS (
              SELECT 1
              FROM sandbox_provision_recoveries live_sandbox
              WHERE live_sandbox.scope = l.scope
                AND live_sandbox.sandbox_key = l.sandbox_key
                AND live_sandbox.status = 'leased'
                AND live_sandbox.lease_expires_at > ${now.toISOString()}
            )
            AND (
              l.control_state = 'closed'
              OR (
                l.scope_rank = 1
                AND NOT EXISTS (
                  SELECT 1
                  FROM sandbox_provision_recoveries live
                  WHERE live.scope = l.scope
                    AND live.status = 'leased'
                    AND live.claim_kind = 'half_open_probe'
                    AND live.lease_expires_at > ${now.toISOString()}
                )
              )
            )
          ORDER BY l.attempt_count, l.next_attempt_at, l.created_at, l.execution_id
          LIMIT ${PROVISION_RECOVERY_BATCH_SIZE}
        ), locked AS (
          SELECT r.execution_id, candidates.claim_kind
          FROM sandbox_provision_recoveries r
          JOIN candidates ON candidates.execution_id = r.execution_id
          WHERE (
            (r.status = 'waiting' AND r.next_attempt_at <= ${now.toISOString()})
            OR (r.status = 'leased' AND r.lease_expires_at <= ${now.toISOString()})
          )
          FOR UPDATE OF r SKIP LOCKED
        )
        UPDATE sandbox_provision_recoveries r
        SET status = 'leased',
            lease_owner = ${ownerId},
            lease_expires_at = ${leaseExpiresAt.toISOString()},
            claim_kind = locked.claim_kind,
            updated_at = ${now.toISOString()}
        FROM locked
        WHERE r.execution_id = locked.execution_id
        RETURNING r.execution_id, r.agent_id, r.work_stream_id, r.scope, r.sandbox_key,
                  r.generation, r.attempt_count, r.deadline_at, r.lease_owner,
                  r.lease_expires_at, r.claim_kind
      `)) as unknown as Array<Record<string, unknown>>

      return rows.map((row) => ({
        executionId: String(row.execution_id),
        agentId: String(row.agent_id),
        workStreamId: row.work_stream_id ? String(row.work_stream_id) : null,
        scope: String(row.scope),
        sandboxKey: String(row.sandbox_key),
        generation: Number(row.generation),
        attemptCount: Number(row.attempt_count),
        deadlineAt: new Date(row.deadline_at as string | Date),
        leaseOwner: String(row.lease_owner),
        leaseExpiresAt: new Date(row.lease_expires_at as string | Date),
        claimKind: row.claim_kind as ProvisionRecoveryClaimKind,
      }))
    })
  }
}
