import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../../db'
import { eventEmitter } from '../../../lib/infra/event-emitter'

export interface ToolchainCleanupBatchOptions {
  retentionMs: number
  batchSize: number
}

const MAX_BATCH_SIZE = 1_000

export interface ToolchainCleanupExecutor {
  execute(query: SQL): Promise<unknown>
}

function validateOptions(options: ToolchainCleanupBatchOptions): void {
  if (!Number.isFinite(options.retentionMs) || options.retentionMs < 0) {
    throw new RangeError('retentionMs must be a non-negative finite number')
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > MAX_BATCH_SIZE) {
    throw new RangeError(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`)
  }
}

function ids(rows: unknown): string[] {
  return (rows as Array<{ sandboxId: string }>).map((row) => row.sandboxId)
}

/** Delete one DB-clock-owned, deterministically ordered batch of expired terminal result evidence. */
export async function cleanupTerminalToolchainResultsBatch(
  options: ToolchainCleanupBatchOptions,
  executor: ToolchainCleanupExecutor = db
): Promise<string[]> {
  validateOptions(options)
  const rows = await executor.execute(sql`
    WITH candidates AS (
      SELECT sandbox_id, completed_at
      FROM sandbox_toolchain_provisions
      WHERE status IN ('ready', 'failed')
        AND completed_at < CURRENT_TIMESTAMP - (${options.retentionMs} * interval '1 millisecond')
      ORDER BY completed_at, sandbox_id
      FOR UPDATE SKIP LOCKED
      LIMIT ${options.batchSize}
    ), deleted AS (
      DELETE FROM sandbox_toolchain_provisions AS provision
      USING candidates
      WHERE provision.sandbox_id = candidates.sandbox_id
      RETURNING provision.sandbox_id
    )
    SELECT candidates.sandbox_id AS "sandboxId"
    FROM candidates
    JOIN deleted USING (sandbox_id)
    ORDER BY candidates.completed_at, candidates.sandbox_id
  `)
  const deleted = ids(rows)
  for (const sandboxId of deleted) eventEmitter.emit('sandbox.status', { sandboxId })
  return deleted
}

/**
 * Delete one bounded batch of evidence whose logical sandbox no longer belongs
 * to an extant same-squad agent. Canonical squad boxes remain owned by their
 * squad row and hard squad deletion remains FK-cascade owned.
 */
export async function cleanupOrphanToolchainStateBatch(
  options: ToolchainCleanupBatchOptions,
  executor: ToolchainCleanupExecutor = db
): Promise<string[]> {
  validateOptions(options)
  const rows = await executor.execute(sql`
    WITH evidence AS MATERIALIZED (
      SELECT sandbox_id, squad_id, updated_at FROM sandbox_toolchain_provisions
      UNION ALL
      SELECT sandbox_id, squad_id, updated_at FROM sandbox_toolchain_activations
    ), logical_orphans AS MATERIALIZED (
      SELECT evidence.sandbox_id, MIN(evidence.squad_id::text)::uuid AS squad_id,
             MAX(evidence.updated_at) AS updated_at
      FROM evidence
      WHERE evidence.sandbox_id <> 'squad_' || evidence.squad_id::text
        AND NOT EXISTS (
          SELECT 1 FROM agents AS agent
          WHERE evidence.sandbox_id = 'agent_' || agent.id::text
            AND evidence.squad_id = agent.squad_id
        )
      GROUP BY evidence.sandbox_id
      HAVING COUNT(DISTINCT evidence.squad_id) = 1
        AND MAX(evidence.updated_at) < CURRENT_TIMESTAMP - (${options.retentionMs} * interval '1 millisecond')
    ), provision_claims AS MATERIALIZED (
      SELECT orphan.sandbox_id, orphan.squad_id, orphan.updated_at,
             EXISTS (
               SELECT 1 FROM sandbox_toolchain_activations AS activation
               WHERE activation.sandbox_id = orphan.sandbox_id
                 AND activation.squad_id = orphan.squad_id
             ) AS activation_present
      FROM logical_orphans AS orphan
      JOIN sandbox_toolchain_provisions AS provision
        ON provision.sandbox_id = orphan.sandbox_id AND provision.squad_id = orphan.squad_id
      WHERE provision.updated_at < CURRENT_TIMESTAMP - (${options.retentionMs} * interval '1 millisecond')
      ORDER BY orphan.updated_at, orphan.sandbox_id
      FOR UPDATE OF provision SKIP LOCKED
      LIMIT ${options.batchSize}
    ), activation_counterpart_claims AS MATERIALIZED (
      SELECT claim.sandbox_id, claim.squad_id
      FROM provision_claims AS claim
      JOIN sandbox_toolchain_activations AS activation
        ON activation.sandbox_id = claim.sandbox_id AND activation.squad_id = claim.squad_id
      WHERE activation.updated_at < CURRENT_TIMESTAMP - (${options.retentionMs} * interval '1 millisecond')
      ORDER BY claim.updated_at, claim.sandbox_id
      FOR UPDATE OF activation
    ), activation_only_claims AS MATERIALIZED (
      SELECT orphan.sandbox_id, orphan.squad_id, orphan.updated_at
      FROM logical_orphans AS orphan
      JOIN sandbox_toolchain_activations AS activation
        ON activation.sandbox_id = orphan.sandbox_id AND activation.squad_id = orphan.squad_id
      WHERE activation.updated_at < CURRENT_TIMESTAMP - (${options.retentionMs} * interval '1 millisecond')
        AND NOT EXISTS (
        SELECT 1 FROM sandbox_toolchain_provisions AS provision
        WHERE provision.sandbox_id = orphan.sandbox_id AND provision.squad_id = orphan.squad_id
      )
      ORDER BY orphan.updated_at, orphan.sandbox_id
      FOR UPDATE OF activation SKIP LOCKED
      LIMIT ${options.batchSize}
    ), candidates AS MATERIALIZED (
      SELECT sandbox_id, squad_id, updated_at
      FROM (
        SELECT claim.sandbox_id, claim.squad_id, claim.updated_at
        FROM provision_claims AS claim
        WHERE NOT claim.activation_present
           OR EXISTS (
             SELECT 1 FROM activation_counterpart_claims AS activation
             WHERE activation.sandbox_id = claim.sandbox_id AND activation.squad_id = claim.squad_id
           )
        UNION ALL
        SELECT * FROM activation_only_claims
      ) AS owned
      ORDER BY updated_at, sandbox_id
      LIMIT ${options.batchSize}
    ), deleted_provisions AS (
      DELETE FROM sandbox_toolchain_provisions AS provision
      USING candidates
      WHERE provision.sandbox_id = candidates.sandbox_id
        AND provision.squad_id = candidates.squad_id
      RETURNING provision.sandbox_id
    ), deleted_activations AS (
      DELETE FROM sandbox_toolchain_activations AS activation
      USING candidates
      WHERE activation.sandbox_id = candidates.sandbox_id
        AND activation.squad_id = candidates.squad_id
      RETURNING activation.sandbox_id
    )
    SELECT sandbox_id AS "sandboxId" FROM candidates ORDER BY updated_at, sandbox_id
  `)
  const deleted = ids(rows)
  for (const sandboxId of deleted) eventEmitter.emit('sandbox.status', { sandboxId })
  return deleted
}
