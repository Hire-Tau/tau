import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  chatSendReceipts,
  db,
  executionAdmissionReservations,
  executions,
  messages,
  workStreamContinuations,
} from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { acquireAgentQueueLock, classifyStrandedQueuedAdmission, restoreQueueOwnedAdmission } from './agent-admission'
import { ACTIVE_EXECUTION_STATUSES } from './status'

const log = createLogger('admission-reconciliation')
const TERMINAL_ADMISSION_STATES = ['released', 'revoked'] as const

/**
 * Repair active-row/admission drift at the safe startup boundary, after old
 * worker processes have stopped and before running recovery or queued pickup.
 */
export async function reconcileDuplicateActiveExecutions(options?: { agentIds?: string[] }): Promise<number> {
  const activeAgents = options?.agentIds
    ? [...new Set(options.agentIds)].map((agent_id) => ({ agent_id }))
    : ((await db.execute(sql`
        SELECT DISTINCT agent_id
        FROM executions
        WHERE status IN ('queued', 'waiting-maintenance', 'running', 'stopping', 'waiting-sandbox')
      `)) as unknown as Array<{ agent_id: string }>)

  let repaired = 0
  for (const { agent_id: agentId } of activeAgents) {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)
      await acquireAgentQueueLock(tx, agentId)
      const active = await tx
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, agentId), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])))
        .orderBy(
          sql`CASE ${executions.status} WHEN 'running' THEN 0 WHEN 'stopping' THEN 1 WHEN 'waiting-sandbox' THEN 2 WHEN 'waiting-maintenance' THEN 3 ELSE 4 END`,
          asc(executions.startedAt),
          asc(executions.id)
        )
        .for('update')
      if (!active.length) return null
      const activeIds = active.map(({ id }) => id)

      const reservations = await tx
        .select()
        .from(executionAdmissionReservations)
        .where(inArray(executionAdmissionReservations.executionId, activeIds))
        .for('update')
      const [clock] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(executions)
        .where(inArray(executions.id, activeIds))
        .limit(1)
      if (!clock) return null
      const admissionClassifications = new Map<string, Awaited<ReturnType<typeof classifyStrandedQueuedAdmission>>>()
      for (const reservation of reservations) {
        const execution = active.find(({ id }) => id === reservation.executionId)
        if (!execution || execution.status !== 'queued') continue
        admissionClassifications.set(
          reservation.executionId,
          await classifyStrandedQueuedAdmission(tx, {
            execution,
            reservation,
            now: new Date(clock.now),
          })
        )
      }
      const validReservations = reservations.filter(
        (reservation) =>
          !TERMINAL_ADMISSION_STATES.includes(reservation.state as (typeof TERMINAL_ADMISSION_STATES)[number]) &&
          admissionClassifications.get(reservation.executionId)?.kind !== 'recoverable'
      )

      const streamEvidence = await tx
        .select({
          executionId: sql<string>`${messages.metadata}->>'executionId'`,
          messageId: messages.id,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.agentId, agentId),
            eq(messages.role, 'assistant'),
            inArray(sql`${messages.metadata}->>'executionId'`, activeIds)
          )
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
      const continuationEvidence = await tx
        .select({
          executionId: workStreamContinuations.deliveryExecutionId,
          updatedAt: workStreamContinuations.updatedAt,
        })
        .from(workStreamContinuations)
        .where(inArray(workStreamContinuations.deliveryExecutionId, activeIds))
        .orderBy(desc(workStreamContinuations.updatedAt))
      const receiptEvidence = await tx
        .select({ executionId: chatSendReceipts.executionId, clientId: chatSendReceipts.clientId })
        .from(chatSendReceipts)
        .where(inArray(chatSendReceipts.executionId, activeIds))

      let canonical =
        validReservations.length === 1 ? active.find(({ id }) => id === validReservations[0]?.executionId) : undefined
      let canonicalReason = 'admission'
      if (!canonical && streamEvidence[0]) {
        canonical = active.find(({ id }) => id === streamEvidence[0]?.executionId)
        canonicalReason = 'durable-stream-output'
      }
      if (!canonical && continuationEvidence[0]?.executionId) {
        canonical = active.find(({ id }) => id === continuationEvidence[0]?.executionId)
        canonicalReason = 'continuation-delivery'
      }
      if (!canonical) {
        canonical = active[0]!
        canonicalReason = 'deterministic-status-order'
      }

      const duplicates = active.filter(({ id }) => id !== canonical.id)
      const canonicalReservation = reservations.find(({ executionId }) => executionId === canonical.id)
      const canonicalClassification = admissionClassifications.get(canonical.id)
      const admissionValid =
        canonicalReservation?.agentId === agentId &&
        !TERMINAL_ADMISSION_STATES.includes(canonicalReservation.state as (typeof TERMINAL_ADMISSION_STATES)[number]) &&
        canonicalClassification?.kind !== 'recoverable'
      if (!duplicates.length && admissionValid) return null

      const now = new Date()
      if (duplicates.length) {
        await tx
          .update(executions)
          .set({ status: 'stopped', endedAt: now, error: 'Stopped by startup duplicate-admission reconciliation' })
          .where(
            inArray(
              executions.id,
              duplicates.map(({ id }) => id)
            )
          )
        await tx
          .update(executionAdmissionReservations)
          .set({ state: 'revoked', updatedAt: now })
          .where(
            inArray(
              executionAdmissionReservations.executionId,
              duplicates.map(({ id }) => id)
            )
          )
      }

      // A stale current row not attached to an active execution must release the
      // partial unique slot before canonical admission is repaired.
      await tx
        .update(executionAdmissionReservations)
        .set({ state: 'revoked', updatedAt: now })
        .where(
          and(
            eq(executionAdmissionReservations.agentId, agentId),
            sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`,
            sql`${executionAdmissionReservations.executionId} <> ${canonical.id}`
          )
        )
      const canonicalState = canonical.status === 'waiting-maintenance' ? 'waiting-maintenance' : 'queued'
      if (
        !canonicalReservation ||
        TERMINAL_ADMISSION_STATES.includes(canonicalReservation.state as (typeof TERMINAL_ADMISSION_STATES)[number]) ||
        canonicalClassification?.kind === 'recoverable'
      ) {
        const restored = await restoreQueueOwnedAdmission(tx, {
          agentId,
          executionId: canonical.id,
          state: canonicalState,
          ...(canonicalClassification?.kind === 'recoverable'
            ? { expectedLease: canonicalClassification.expectedLease }
            : {}),
        })
        if (!restored) throw new Error('Admission reconciliation lost its canonical reservation repair')
      } else if (canonicalReservation.agentId !== agentId) {
        await tx
          .update(executionAdmissionReservations)
          .set({ agentId, updatedAt: now })
          .where(eq(executionAdmissionReservations.executionId, canonical.id))
      }

      return {
        canonicalId: canonical.id,
        canonicalReason,
        canonicalStatus: canonical.status,
        canonicalStartedAt: canonical.startedAt,
        duplicateRows: duplicates.map(({ id, status, startedAt }) => ({ id, status, startedAt })),
        receiptEvidence,
        continuationEvidence,
        streamEvidence,
        repairedCount: Math.max(duplicates.length, 1),
      }
    })
    if (!result) continue
    repaired += result.repairedCount
    log.warn('Reconciled active execution admission at startup', {
      agentId,
      activeRowCount: result.duplicateRows.length + 1,
      duplicateCount: result.duplicateRows.length,
      receiptEvidenceCount: result.receiptEvidence.length,
      continuationEvidenceCount: result.continuationEvidence.length,
      streamEvidenceCount: result.streamEvidence.length,
      ...result,
    })
    for (const duplicate of result.duplicateRows) {
      const payload = { executionId: duplicate.id, agentId, status: 'stopped' as const }
      eventEmitter.emit('execution.updated', payload)
      eventEmitter.emit('execution.stopped', payload)
    }
    eventEmitter.emit('execution.updated', {
      executionId: result.canonicalId,
      agentId,
      status: result.canonicalStatus,
    })
  }
  return repaired
}
