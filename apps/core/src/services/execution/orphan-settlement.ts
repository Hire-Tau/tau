import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, executionAdmissionReservations, executions, sandboxProvisionRecoveries } from '../../db/schema'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { acquireAgentQueueLock } from './agent-admission'
import {
  isLeaseBearingReservation,
  settleExactAdmissionLease,
  type AdmissionLease,
} from '../maintenance/admission-reservation'
import { AGENT_REMOVED_FAILURE } from './failure-classification'
import { ACTIVE_EXECUTION_STATUSES } from './status'

const log = createLogger('orphan-settlement')

export type RemovedAgentSettleResult = 'settled' | 'agent-live' | 'not-active'

/**
 * Settle ONE execution whose owning agent can no longer run it — the agent row
 * is gone, or the agent is `terminated`. Belt and braces for the 2026-09-04
 * dead-fleet incident: non-terminal execution rows (any ACTIVE_EXECUTION_STATUSES
 * shape) whose agent was removed (unspawn/delete raced a queue write, or an
 * FK-bypassed restore left them behind) sat in a demand state forever — counted
 * by fleet demand detection, re-nudged by the queue watchdog, and served by
 * nothing.
 *
 * Mirrors `Execution.transitionTo`'s fenced terminal write (maintenance fence →
 * execution CAS → admission release → sandbox-recovery cancel → post-commit
 * events) with ONE deliberate difference: it never writes the agents row. The
 * generic 'failed' disposition would set the agent back to `idle`,
 * resurrecting a terminated agent; and for a missing agent row
 * `Execution.fail()` cannot even run (`mustGetAgent` throws). No system
 * message is recorded either — the owning chat is gone with the agent.
 *
 * Safe under concurrency: the row lock plus a status-in-active CAS make this
 * idempotent, and a live/dormant agent — including one that wakes between the
 * caller's check and this transaction — is never touched (result
 * `'agent-live'`). Dormant agents stay eligible: pickup wakes them for
 * wake-eligible queued work, so their executions are genuine demand.
 *
 * RUNNING executions, specifically: normal termination never sees one —
 * `terminate()` CAS-gates on `agents.status = 'dormant'`, which `makeDormant`
 * only reaches once the agent's active execution has settled — so running/
 * stopping coverage exists for runnerless legacy-repair rows that would
 * otherwise churn (the watchdog's orphan arm requeues a sessionless `running`
 * row after ORPHANED_RUNNING_THRESHOLD_MS, sending it back around as queued
 * demand — the incident's own entry shape). If a runner were genuinely
 * mid-session, this settle's `settleExactAdmissionLease(..., 'released')` makes
 * its lease terminal, so the runner's write-phase finish takes the
 * `isLeaseTerminal` return (agent-runners/base.ts) instead of a finish-refusal,
 * and a completion that lands afterward still matches `transitionTo`'s
 * runnerClaim predicates (this settle never clears the claim token) — its
 * truthful terminal outcome wins the row under the pre-existing concurrent-
 * terminal last-writer-wins rule.
 */
export async function settleExecutionForRemovedAgent(executionId: string): Promise<RemovedAgentSettleResult> {
  const result = await db.transaction(async (tx) => {
    // Same fence transitionTo takes for kinds that settle admission.
    await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)

    const [execution] = await tx
      .select({ agentId: executions.agentId })
      .from(executions)
      .where(eq(executions.id, executionId))
      .limit(1)
    if (!execution) return { kind: 'not-active' as const }

    const [agentRow] = await tx
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, execution.agentId))
      .limit(1)
    if (agentRow) {
      if (agentRow.status !== 'terminated') return { kind: 'agent-live' as const }
      // Serialize with wake/pickup producers for this agent (same advisory
      // lock every producer path takes), then re-verify under the lock: a
      // wake may have committed between the read above and the lock.
      await acquireAgentQueueLock(tx, execution.agentId)
      const [rechecked] = await tx
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, execution.agentId))
        .limit(1)
      if (!rechecked || rechecked.status !== 'terminated') return { kind: 'agent-live' as const }
    }
    // A MISSING agent row needs no advisory lock: agent ids are UUIDs and are
    // never recreated, so nothing can wake it between here and the CAS.

    const [locked] = await tx.select().from(executions).where(eq(executions.id, executionId)).for('update')
    if (!locked || !ACTIVE_EXECUTION_STATUSES.includes(locked.status as (typeof ACTIVE_EXECUTION_STATUSES)[number])) {
      return { kind: 'not-active' as const }
    }

    const [updated] = await tx
      .update(executions)
      .set({
        status: 'failed',
        endedAt: new Date(),
        error: `Agent ${locked.agentId} was removed before this execution could start`,
        failureClass: AGENT_REMOVED_FAILURE.failureClass,
        failureReason: AGENT_REMOVED_FAILURE.failureReason,
        maintenanceGeneration: null,
        maintenanceQueuedAt: null,
      })
      .where(and(eq(executions.id, executionId), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])))
      .returning()
    // A concurrent terminal write won the row — nothing left to do.
    if (!updated) return { kind: 'not-active' as const }

    // Release the admission reservation exactly like transitionTo's terminal
    // kinds: queue-owned states release outright; a lease-bearing reservation
    // settles under its exact identity so a stale path can never clear a
    // successor's slot.
    const [reservation] = await tx
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, executionId))
      .for('update')
    if (reservation && !['released', 'revoked'].includes(reservation.state)) {
      if (['queued', 'waiting-maintenance'].includes(reservation.state)) {
        await tx
          .update(executionAdmissionReservations)
          .set({ state: 'released', updatedAt: new Date() })
          .where(
            and(
              eq(executionAdmissionReservations.executionId, executionId),
              eq(executionAdmissionReservations.state, reservation.state)
            )
          )
      } else if (isLeaseBearingReservation(reservation)) {
        const lease: AdmissionLease = {
          executionId: reservation.executionId,
          token: reservation.token,
          claimEpoch: reservation.claimEpoch,
          ownerId: reservation.ownerId,
          ownerIncarnation: reservation.ownerIncarnation,
          generation: reservation.admittedGeneration,
          holderRevision: reservation.admittedHolderRevision,
        }
        // A lost exact CAS means the reservation already moved on; the
        // execution row is terminal either way.
        await settleExactAdmissionLease(tx, lease, 'released')
      } else {
        // Legacy/incomplete identity on a non-queue state: the execution is
        // terminal, so the reservation is garbage — release it outright.
        await tx
          .update(executionAdmissionReservations)
          .set({ state: 'released', updatedAt: new Date() })
          .where(
            and(
              eq(executionAdmissionReservations.executionId, executionId),
              eq(executionAdmissionReservations.state, reservation.state)
            )
          )
      }
    }

    await tx
      .update(sandboxProvisionRecoveries)
      .set({
        status: 'cancelled',
        leaseOwner: null,
        leaseExpiresAt: null,
        claimKind: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sandboxProvisionRecoveries.executionId, executionId),
          inArray(sandboxProvisionRecoveries.status, ['waiting', 'leased'])
        )
      )

    return { kind: 'settled' as const, row: updated }
  })

  if (result.kind !== 'settled') return result.kind

  // Post-commit only (DEFAULT_POOL_MAX invariant: no pool connection survives
  // an external effect) — same event shape transitionTo's 'failed' path emits.
  const payload = {
    executionId: result.row.id,
    agentId: result.row.agentId,
    status: 'failed' as const,
  }
  eventEmitter.emit('execution.updated', payload)
  eventEmitter.emit('execution.failed', {
    ...payload,
    failureClass: AGENT_REMOVED_FAILURE.failureClass,
    failureReason: AGENT_REMOVED_FAILURE.failureReason,
  })
  // Best-effort provider-slot release, mirroring transitionTo's terminal
  // kinds: durable settle success must not depend on the in-memory limiter.
  try {
    const { concurrencyLimiter } = await import('./concurrency-limiter-instance')
    concurrencyLimiter.release(result.row.id)
  } catch {
    // ignore
  }
  return 'settled'
}

/**
 * Settle every non-terminal execution of one removed agent — the
 * `agent.terminated` cleanup hook. Each row goes through
 * {@link settleExecutionForRemovedAgent}, which re-verifies the agent is
 * actually gone/terminated, so a live agent is never touched.
 */
export async function settleExecutionsForRemovedAgent(
  agentId: string,
  options: { maxCandidates?: number } = {}
): Promise<number> {
  const maxCandidates = Math.max(1, options.maxCandidates ?? 50)
  const candidates = await db
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.agentId, agentId), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])))
    .orderBy(asc(executions.startedAt), asc(executions.id))
    .limit(maxCandidates)
  let settled = 0
  for (const candidate of candidates) {
    if ((await settleExecutionForRemovedAgent(candidate.id)) === 'settled') settled++
  }
  return settled
}

/**
 * One-time, idempotent, bounded startup reconciliation for orphaned rows that
 * predate the termination-time settle (the live 2026-09-04 incident): settles
 * non-terminal executions whose agent row no longer exists or is terminated.
 * Never touches executions of live or dormant agents — per row, the settle
 * transaction re-verifies the agent state, so a candidate list that raced a
 * wake is harmless. Safe under concurrent workers: each settle is a
 * row-locked, status-CAS transaction with exactly one winner.
 */
export async function settleOrphanedExecutionsOnce(options: { maxCandidates?: number } = {}): Promise<number> {
  const maxCandidates = Math.max(1, options.maxCandidates ?? 50)
  const candidates = await db
    .select({ id: executions.id })
    .from(executions)
    .leftJoin(agents, eq(agents.id, executions.agentId))
    .where(
      and(
        inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES]),
        or(isNull(agents.id), eq(agents.status, 'terminated'))
      )
    )
    .orderBy(asc(executions.startedAt), asc(executions.id))
    .limit(maxCandidates)
  let settled = 0
  for (const candidate of candidates) {
    try {
      if ((await settleExecutionForRemovedAgent(candidate.id)) === 'settled') settled++
    } catch (error) {
      log.warn(`Orphaned execution settlement failed for ${candidate.id}`, error)
    }
  }
  return settled
}
