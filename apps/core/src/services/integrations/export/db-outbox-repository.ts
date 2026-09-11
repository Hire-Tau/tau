import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db, integrationExportBatches, integrationExportCursors } from '../../../db'
import type { ExportBatchRecord, ExportOutboxRepository } from './outbox'

export class DbExportOutboxRepository implements ExportOutboxRepository {
  async createBatch(input: Parameters<ExportOutboxRepository['createBatch']>[0]): Promise<ExportBatchRecord | null> {
    const [row] = await db
      .insert(integrationExportBatches)
      .values({ ...input, createdAt: input.now, updatedAt: input.now })
      .onConflictDoNothing()
      .returning()
    return row ? map(row) : null
  }
  async claimNext(input: Parameters<ExportOutboxRepository['claimNext']>[0]): Promise<ExportBatchRecord | null> {
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(integrationExportBatches)
        .where(
          and(
            inArray(integrationExportBatches.state, ['pending', 'retry_wait', 'processing']),
            lte(integrationExportBatches.nextAttemptAt, input.now),
            or(
              inArray(integrationExportBatches.state, ['pending', 'retry_wait']),
              isNull(integrationExportBatches.leaseExpiresAt),
              lte(integrationExportBatches.leaseExpiresAt, input.now)
            ),
            // A later completion must remain queued behind every earlier
            // retryable/nonterminal batch for the same cursor. This predicate
            // is evaluated and locked in the claiming transaction, so workers
            // cannot skip ahead while an earlier lease or retry is outstanding.
            sql`NOT EXISTS (
              SELECT 1
              FROM ${integrationExportBatches} AS earlier
              WHERE earlier.cursor_id = ${integrationExportBatches.cursorId}
                AND earlier.first_enqueue_order < ${integrationExportBatches.firstEnqueueOrder}
                AND earlier.state IN ('pending', 'processing', 'retry_wait')
            )`
          )
        )
        .orderBy(
          asc(integrationExportBatches.nextAttemptAt),
          asc(integrationExportBatches.firstEnqueueOrder),
          asc(integrationExportBatches.createdAt)
        )
        .limit(1)
        .for('update', { skipLocked: true })
      if (!candidate) return null
      const [row] = await tx
        .update(integrationExportBatches)
        .set({
          state: 'processing',
          leaseToken: input.leaseToken,
          leaseExpiresAt: input.leaseExpiresAt,
          updatedAt: input.now,
        })
        .where(eq(integrationExportBatches.id, candidate.id))
        .returning()
      return map(row)
    })
  }
  async markRetry(input: Parameters<ExportOutboxRepository['markRetry']>[0]): Promise<boolean> {
    return this.transition(input.batchId, input.leaseToken, {
      state: 'retry_wait',
      nextAttemptAt: input.nextAttemptAt,
      lastErrorCode: input.code,
      leaseToken: null,
      leaseExpiresAt: null,
      attempts: sql`${integrationExportBatches.attempts} + 1`,
    })
  }
  async markDeadLetter(input: Parameters<ExportOutboxRepository['markDeadLetter']>[0]): Promise<boolean> {
    return this.transition(input.batchId, input.leaseToken, {
      state: 'dead_letter',
      lastErrorCode: input.code,
      leaseToken: null,
      leaseExpiresAt: null,
    })
  }
  async cancel(input: Parameters<ExportOutboxRepository['cancel']>[0]): Promise<boolean> {
    return this.transition(input.batchId, input.leaseToken, {
      state: 'canceled',
      lastErrorCode: input.code,
      encryptedPayload: null,
      payloadIv: null,
      leaseToken: null,
      leaseExpiresAt: null,
    })
  }
  async deliverAndAdvance(input: Parameters<ExportOutboxRepository['deliverAndAdvance']>[0]): Promise<boolean> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .update(integrationExportBatches)
        .set({
          state: 'delivered',
          deliveredAt: input.deliveredAt,
          encryptedPayload: null,
          payloadIv: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: input.deliveredAt,
        })
        .where(
          and(
            eq(integrationExportBatches.id, input.batchId),
            eq(integrationExportBatches.leaseToken, input.leaseToken),
            eq(integrationExportBatches.state, 'processing')
          )
        )
        .returning({ id: integrationExportBatches.id })
      if (rows.length !== 1) return false
      await tx
        .update(integrationExportCursors)
        .set({ lastDeliveredEnqueueOrder: input.lastEnqueueOrder, updatedAt: input.deliveredAt })
        .where(eq(integrationExportCursors.id, input.cursorId))
      return true
    })
  }
  private async transition(id: string, leaseToken: string, values: Record<string, unknown>): Promise<boolean> {
    const rows = await db
      .update(integrationExportBatches)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(
          eq(integrationExportBatches.id, id),
          eq(integrationExportBatches.leaseToken, leaseToken),
          eq(integrationExportBatches.state, 'processing')
        )
      )
      .returning({ id: integrationExportBatches.id })
    return rows.length === 1
  }
}
function map(row: typeof integrationExportBatches.$inferSelect): ExportBatchRecord {
  return {
    id: row.id,
    cursorId: row.cursorId,
    idempotencyKey: row.idempotencyKey,
    firstEnqueueOrder: row.firstEnqueueOrder,
    lastEnqueueOrder: row.lastEnqueueOrder,
    recordCount: row.recordCount,
    byteCount: row.byteCount,
    encryptedPayload: row.encryptedPayload,
    payloadIv: row.payloadIv,
    state: row.state,
    attempts: row.attempts,
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
    nextAttemptAt: row.nextAttemptAt,
  }
}
