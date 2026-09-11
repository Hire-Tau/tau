import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { workStreamContinuations } from '../../db/schema'

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function resetContinuationCycle(
  tx: DbTransaction,
  workStreamId: string,
  assigneeAgentId: string | null,
  now = new Date()
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

export async function invalidateContinuationCycle(
  tx: DbTransaction,
  workStreamId: string,
  now = new Date()
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
