import { posix as path } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import {
  db,
  squads,
  workStreams,
  workStreamWorktrees,
  worktreeCleanupJobs,
  executions,
  workflowBindings,
} from '../../db'
import { acquireAgentQueueLock } from '../execution/agent-admission'
import { ACTIVE_EXECUTION_STATUSES } from '../execution/status'
import type { WorktreeOwnership } from './repository-setup'
import type { WorktreeRemovalInput } from './worktree-cleanup-runtime'

export function cleanupDeliveryBinding(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ['git', 'codeHost', 'github'].filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]])
  )
}

export function referencesOwnedWorktree(metadata: Record<string, unknown>, ownership: WorktreeOwnership): boolean {
  const candidate = (metadata.git as Record<string, unknown> | undefined)?.worktree
  if (typeof candidate !== 'string') return false
  const resolved = path.resolve(ownership.workspace, candidate)
  return (
    resolved === ownership.worktree ||
    resolved.startsWith(`${ownership.worktree}/`) ||
    ownership.worktree.startsWith(`${resolved}/`)
  )
}

/** Only this transaction grants destructive dispatch. Shared squad locking protects
 * registered attachments; per-agent queue locks serialize the associated starts.
 * Unrelated agents never participate in the fence. */
export async function claimWorktreeCleanup(
  id: string,
  verified: { ownership: WorktreeOwnership; head: string; metadata: Record<string, unknown> }
): Promise<WorktreeRemovalInput | null> {
  const [before] = await db.select({ squadId: workStreams.squadId }).from(workStreams).where(eq(workStreams.id, id))
  if (!before) return null
  return db.transaction(async (tx) => {
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, before.squadId)).for('update')
    const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, id)).for('update')
    const [job] = await tx
      .select()
      .from(worktreeCleanupJobs)
      .where(eq(worktreeCleanupJobs.workStreamId, id))
      .for('update')
    if (!stream || !job || !['pending', 'deferred', 'error'].includes(job.status) || job.operationId) return null
    const defer = async (reason: string, status: 'deferred' | 'skipped' = 'deferred') => {
      await tx
        .update(worktreeCleanupJobs)
        .set({ status, reason, nextAttemptAt: new Date(Date.now() + 60_000), updatedAt: new Date() })
        .where(eq(worktreeCleanupJobs.workStreamId, id))
      return null
    }
    if (stream.status !== 'done' || stream.pause)
      return defer('Only delivered, unpaused work streams are eligible', 'skipped')
    if (!stream.autoCleanupWorktree) return defer('Worktree retention is enabled', 'skipped')
    const metadata = stream.metadata as Record<string, unknown>
    if ((stream.files as unknown[]).length) return defer('Attached evidence must be retained or moved before cleanup')
    const [registered] = await tx.select().from(workStreamWorktrees).where(eq(workStreamWorktrees.workStreamId, id))
    if (!registered) return defer('No platform-created worktree ownership record', 'skipped')
    if (
      !isDeepStrictEqual(registered.ownership, verified.ownership) ||
      job.deliveredHead !== verified.head ||
      !/^[a-f0-9]{40}$/.test(verified.head) ||
      !isDeepStrictEqual(cleanupDeliveryBinding(metadata), cleanupDeliveryBinding(verified.metadata)) ||
      !isDeepStrictEqual(job.deliveryMetadata, cleanupDeliveryBinding(verified.metadata))
    )
      return defer('Delivery or registered repository bindings changed; retain for inspection')
    const git = metadata.git as Record<string, unknown> | undefined
    if (
      git?.worktree !== registered.ownership.worktree ||
      git?.repository !== registered.ownership.repository ||
      git?.branch !== registered.ownership.branch
    )
      return defer('Current git bindings do not match the owned worktree')
    const otherStreams = await tx.select().from(workStreams).where(eq(workStreams.squadId, stream.squadId))
    if (
      otherStreams.some(
        (other) =>
          other.id !== id &&
          ((other.dependsOn ?? []).includes(id) ||
            referencesOwnedWorktree(other.metadata as Record<string, unknown>, registered.ownership))
      )
    )
      return defer('Another work stream is attached to this worktree or depends on it')
    const bindings = await tx
      .select({ agentId: workflowBindings.agentId })
      .from(workflowBindings)
      .where(eq(workflowBindings.workStreamId, id))
    const origins = await tx
      .select({ agentId: executions.agentId })
      .from(executions)
      .where(sql`${executions.flowContext}->>'workStreamId' = ${id}`)
    const crew = [
      ...new Set([
        ...(stream.agentIds ?? []),
        ...(stream.assigneeAgentId ? [stream.assigneeAgentId] : []),
        ...bindings.map((row) => row.agentId),
        ...origins.map((row) => row.agentId),
      ]),
    ].sort()
    for (const agentId of crew) await acquireAgentQueueLock(tx, agentId)
    const active = await tx
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES]),
          or(
            crew.length ? inArray(executions.agentId, crew) : sql`false`,
            sql`${executions.flowContext}->>'workStreamId' = ${id}`
          )
        )
      )
      .limit(1)
    if (active.length) return defer('Associated executions have not settled; cleanup will retry')
    const input: WorktreeRemovalInput = {
      ownership: registered.ownership,
      head: verified.head,
      operationId: crypto.randomUUID(),
    }
    await tx
      .update(worktreeCleanupJobs)
      .set({
        status: 'removing',
        reason: 'Removal claimed; this worktree cannot be reused until terminal proof',
        operationId: input.operationId,
        removalInput: input,
        attempts: job.attempts + 1,
        updatedAt: new Date(),
      })
      .where(eq(worktreeCleanupJobs.workStreamId, id))
    return input
  })
}

export class WorktreeCleanupConflictError extends Error {}
type Store = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Requires the caller's squad->stream lifecycle locks; never expires uncertainty. */
export async function assertWorktreeCleanupMutable(tx: Store, id: string, reopening = false): Promise<void> {
  const [job] = await tx.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, id))
  if (job?.status === 'removing' || (job?.status === 'error' && job.operationId))
    throw new WorktreeCleanupConflictError(
      'Worktree cleanup removal is pending terminal proof. Do not reuse or modify this resource; inspect the cleanup status.'
    )
  if (reopening && job?.status === 'succeeded')
    throw new WorktreeCleanupConflictError(
      'This worktree was reclaimed. Create a new work stream with repository setup before starting more work; the delivered stream remains history.'
    )
}

/** Read under the same agent queue lock used by final cleanup claim and pickup.
 * The SELECT deliberately does not lock a stream row (avoids inverted lock order). */
export async function cleanupWorktreeForAgent(agentId: string, tx: Store = db): Promise<string | null> {
  const rows = await tx
    .select({ id: workStreams.id })
    .from(workStreams)
    .innerJoin(worktreeCleanupJobs, eq(worktreeCleanupJobs.workStreamId, workStreams.id))
    .where(
      and(
        or(
          eq(worktreeCleanupJobs.status, 'removing'),
          and(eq(worktreeCleanupJobs.status, 'error'), sql`${worktreeCleanupJobs.operationId} IS NOT NULL`)
        ),
        or(
          eq(workStreams.assigneeAgentId, agentId),
          sql`${workStreams.agentIds} @> ARRAY[${agentId}]::uuid[]`,
          sql`EXISTS (SELECT 1 FROM ${workflowBindings} WHERE ${workflowBindings.workStreamId} = ${workStreams.id} AND ${workflowBindings.agentId} = ${agentId})`,
          sql`EXISTS (SELECT 1 FROM ${executions} WHERE ${executions.agentId} = ${agentId} AND ${executions.flowContext}->>'workStreamId' = ${workStreams.id}::text)`
        )
      )
    )
    .limit(1)
  return rows[0]?.id ?? null
}

/** Call while holding the squad row, before committing an attachment change. */
export async function assertWorktreeAttachmentsAvailable(
  tx: Store,
  input: {
    id: string
    squadId: string
    metadata: Record<string, unknown>
    dependsOn: string[]
  }
): Promise<void> {
  const protectedTrees = await tx
    .select({
      id: workStreamWorktrees.workStreamId,
      ownership: workStreamWorktrees.ownership,
      status: worktreeCleanupJobs.status,
      operationId: worktreeCleanupJobs.operationId,
    })
    .from(workStreamWorktrees)
    .innerJoin(worktreeCleanupJobs, eq(worktreeCleanupJobs.workStreamId, workStreamWorktrees.workStreamId))
    .where(eq(workStreamWorktrees.squadId, input.squadId))
  for (const tree of protectedTrees) {
    if (tree.id === input.id) continue
    const uncertain = tree.status === 'removing' || (tree.status === 'error' && tree.operationId)
    if (
      (uncertain && input.dependsOn.includes(tree.id)) ||
      ((uncertain || tree.status === 'succeeded') && referencesOwnedWorktree(input.metadata, tree.ownership))
    )
      throw new WorktreeCleanupConflictError(
        'The attached worktree is cleanup-owned or already reclaimed. Use a new provisioned worktree; do not interfere with removal.'
      )
  }
}
