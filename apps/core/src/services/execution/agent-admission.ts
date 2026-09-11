import { and, eq, sql } from 'drizzle-orm'
import { executionAdmissionReservations, executions } from '../../db'
import type { DbTransaction } from '../machines/queries'
import { ADMISSION_LIVENESS_HASH_SEED, ADMISSION_LIVENESS_LOCK_VERSION } from '../maintenance/process-liveness'

export const AGENT_QUEUE_LOCK_NAMESPACE = 421_100

/** Acquire the transaction-scoped lock shared by every producer and pickup path for an agent. */
export async function acquireAgentQueueLock(tx: DbTransaction, agentId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${AGENT_QUEUE_LOCK_NAMESPACE}, hashtext(${agentId}))`)
}

export async function createQueuedAdmission(
  tx: DbTransaction,
  input: { agentId: string; executionId: string; state: 'queued' | 'waiting-maintenance' }
): Promise<void> {
  await tx.insert(executionAdmissionReservations).values({
    agentId: input.agentId,
    executionId: input.executionId,
    state: input.state,
  })
}

export async function loadCurrentAdmission(tx: DbTransaction, agentId: string) {
  const [reservation] = await tx
    .select()
    .from(executionAdmissionReservations)
    .where(
      and(
        eq(executionAdmissionReservations.agentId, agentId),
        sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
      )
    )
    .limit(1)
    .for('update')
  return reservation ?? null
}

/** Release only the named owner; a stale terminal path cannot clear its successor's slot. */
export async function releaseExactAdmission(tx: DbTransaction, agentId: string, executionId: string): Promise<boolean> {
  const [released] = await tx
    .update(executionAdmissionReservations)
    .set({ state: 'released', updatedAt: new Date() })
    .where(
      and(
        eq(executionAdmissionReservations.agentId, agentId),
        eq(executionAdmissionReservations.executionId, executionId),
        sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
      )
    )
    .returning({ executionId: executionAdmissionReservations.executionId })
  return Boolean(released)
}

/**
 * Atomically convert the exact execution admission back to queue ownership.
 * When expectedLease is provided, every lease identity field is CAS-fenced.
 */
export async function restoreQueueOwnedAdmission(
  tx: DbTransaction,
  input: {
    agentId: string
    executionId: string
    state?: 'queued' | 'waiting-maintenance'
    expectedLease?: {
      token: string
      claimEpoch: bigint
      ownerId: string
      ownerIncarnation: string
      admittedGeneration: number
      admittedHolderRevision: bigint
    }
  }
): Promise<boolean> {
  const targetState = input.state ?? 'queued'
  const predicates = [eq(executionAdmissionReservations.executionId, input.executionId)]
  if (input.expectedLease) {
    predicates.push(
      eq(executionAdmissionReservations.token, input.expectedLease.token),
      eq(executionAdmissionReservations.claimEpoch, input.expectedLease.claimEpoch),
      eq(executionAdmissionReservations.ownerId, input.expectedLease.ownerId),
      eq(executionAdmissionReservations.ownerIncarnation, input.expectedLease.ownerIncarnation),
      eq(executionAdmissionReservations.admittedGeneration, input.expectedLease.admittedGeneration),
      eq(executionAdmissionReservations.admittedHolderRevision, input.expectedLease.admittedHolderRevision)
    )
  }
  const now = new Date()
  const [updated] = await tx
    .update(executionAdmissionReservations)
    .set({
      agentId: input.agentId,
      state: targetState,
      token: null,
      claimEpoch: null,
      ownerId: null,
      ownerIncarnation: null,
      admittedGeneration: null,
      admittedHolderRevision: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      phase: 'none',
      phaseSequence: 0,
      operationId: null,
      resourceKey: null,
      revokeGeneration: null,
      revokeHolderRevision: null,
      revokeAdminHold: null,
      revokeLeaseId: null,
      revokeLeaseOwnerTokenId: null,
      revokeRequestedAt: null,
      recoveryOwnerId: null,
      recoveryOwnerIncarnation: null,
      updatedAt: now,
    })
    .where(and(...predicates))
    .returning({ executionId: executionAdmissionReservations.executionId })
  if (updated) return true
  if (input.expectedLease) return false
  const [inserted] = await tx
    .insert(executionAdmissionReservations)
    .values({ executionId: input.executionId, agentId: input.agentId, state: targetState })
    .onConflictDoNothing()
    .returning({ executionId: executionAdmissionReservations.executionId })
  return Boolean(inserted)
}

type ExecutionRow = typeof executions.$inferSelect
type AdmissionReservationRow = typeof executionAdmissionReservations.$inferSelect

export type StrandedQueuedAdmissionClassification =
  | { kind: 'not-recoverable' }
  | { kind: 'owner-live' }
  | {
      kind: 'recoverable'
      expectedLease: NonNullable<Parameters<typeof restoreQueueOwnedAdmission>[1]['expectedLease']>
    }

/**
 * Classify the one stranded shape that may be reclaimed safely. The
 * transaction-scoped owner lock is both the death proof and the fence held
 * through the caller's subsequent exact restoration CAS.
 */
export async function classifyStrandedQueuedAdmission(
  tx: DbTransaction,
  input: { execution: ExecutionRow; reservation: AdmissionReservationRow; now: Date }
): Promise<StrandedQueuedAdmissionClassification> {
  const { execution, reservation, now } = input
  if (execution.status !== 'queued' || reservation.agentId !== execution.agentId) return { kind: 'not-recoverable' }
  // Queue-owned queued/waiting rows are schema-enforced all-null leases;
  // released/revoked rows are terminal and remain reconciliation-owned.
  if (['queued', 'waiting-maintenance', 'released', 'revoked'].includes(reservation.state))
    return { kind: 'not-recoverable' }
  if (
    reservation.token === null ||
    reservation.claimEpoch === null ||
    reservation.ownerId === null ||
    reservation.ownerIncarnation === null ||
    reservation.admittedGeneration === null ||
    reservation.admittedHolderRevision === null ||
    reservation.leaseExpiresAt === null ||
    reservation.lastHeartbeatAt === null ||
    reservation.leaseExpiresAt > now
  )
    return { kind: 'not-recoverable' }

  const [proof] = await tx
    .select({
      dead: sql<boolean>`pg_try_advisory_xact_lock(hashtextextended(${ADMISSION_LIVENESS_LOCK_VERSION} || ${reservation.ownerIncarnation}, ${ADMISSION_LIVENESS_HASH_SEED}))`,
    })
    .from(executions)
    .where(eq(executions.id, execution.id))
  if (!proof?.dead) return { kind: 'owner-live' }
  return {
    kind: 'recoverable',
    expectedLease: {
      token: reservation.token,
      claimEpoch: reservation.claimEpoch,
      ownerId: reservation.ownerId,
      ownerIncarnation: reservation.ownerIncarnation,
      admittedGeneration: reservation.admittedGeneration,
      admittedHolderRevision: reservation.admittedHolderRevision,
    },
  }
}

/** Restore only a classifier-approved stranded queued admission. */
export async function restoreStrandedQueuedAdmission(
  tx: DbTransaction,
  input: { execution: ExecutionRow; reservation: AdmissionReservationRow; now: Date }
): Promise<StrandedQueuedAdmissionClassification | { kind: 'restored' } | { kind: 'cas-lost' }> {
  const classification = await classifyStrandedQueuedAdmission(tx, input)
  if (classification.kind !== 'recoverable') return classification
  const restored = await restoreQueueOwnedAdmission(tx, {
    agentId: input.execution.agentId,
    executionId: input.execution.id,
    state: 'queued',
    expectedLease: classification.expectedLease,
  })
  return restored ? { kind: 'restored' } : { kind: 'cas-lost' }
}
