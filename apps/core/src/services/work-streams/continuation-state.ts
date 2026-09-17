import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../db'
import { databaseClockNow } from '../../db/clock'
import { workStreamContinuations } from '../../db/schema'

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * `cycleStartedAt` is the progress high-water mark: every later completion is compared against it
 * (`isAfterProgressHighWater`, and the evidence window in `continuation.ts`), and those
 * completions carry `executions.ended_at`, which the DATABASE stamps. So the default here is the
 * database's clock too — a host running ahead would otherwise set a high-water mark in the
 * database's future and make genuine progress look stale, parking the stream.
 *
 * Callers pass `now` only when they have a value from that same clock (a trigger's `endedAt`, an
 * execution's `runStartedAt`); a host `new Date()` argument is exactly what this default replaces.
 */
export async function resetContinuationCycle(
  tx: DbTransaction,
  workStreamId: string,
  assigneeAgentId: string | null,
  now: Date | SQL = databaseClockNow()
): Promise<void> {
  await tx
    .insert(workStreamContinuations)
    .values({ workStreamId, assigneeAgentId, generation: 1, cycleStartedAt: now, status: 'idle' })
    .onConflictDoUpdate({
      target: workStreamContinuations.workStreamId,
      set: {
        assigneeAgentId,
        generation: sql`${workStreamContinuations.generation} + 1`,
        cycleStartedAt: now,
        progressExecutionId: null,
        status: 'idle',
        triggerExecutionId: null,
        normalAttemptCount: 0,
        transportAttemptCount: 0,
        deliveryAttemptCount: 0,
        clientId: null,
        nextAttemptAt: null,
        claimToken: null,
        claimedAt: null,
        deliveryPrompt: null,
        deliveryMessageId: null,
        deliveryExecutionId: null,
        lastDeliveredAt: null,
        lastError: null,
        updatedAt: now,
      },
    })
}

/** Same clock discipline as {@link resetContinuationCycle}: `updatedAt` can seed a later cycle. */
export async function invalidateContinuationCycle(
  tx: DbTransaction,
  workStreamId: string,
  now: Date | SQL = databaseClockNow()
): Promise<void> {
  await tx
    .update(workStreamContinuations)
    .set({
      status: 'idle',
      triggerExecutionId: null,
      clientId: null,
      nextAttemptAt: null,
      claimToken: null,
      claimedAt: null,
      deliveryPrompt: null,
      deliveryMessageId: null,
      deliveryExecutionId: null,
      lastError: null,
      updatedAt: now,
    })
    .where(sql`${workStreamContinuations.workStreamId} = ${workStreamId}`)
}
