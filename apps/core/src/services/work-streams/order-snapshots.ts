import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { db } from '../../db'
import { workStreamOrderSnapshotItems, workStreamOrderSnapshots } from '../../db/schema'

export const WORK_STREAM_ORDER_SNAPSHOT_TTL_MS = 30 * 60 * 1000
export const WORK_STREAM_ORDER_SNAPSHOT_CLEANUP_BATCH_SIZE = 25
const INSERT_CHUNK_SIZE = 500

export interface WorkStreamOrderSnapshot {
  id: string
  ownerKey: string
  requestFingerprint: string
  cursorSecret: string
  snapshotAt: Date
  expiresAt: Date
  nonTerminalCount: number
  terminalTotalCount: number
}

export async function getWorkStreamOrderSnapshotBoundary(): Promise<Date> {
  const [row] = await db.execute<{ now: string }>(sql`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`)
  if (!row) throw new Error('Unable to read the work-stream snapshot database clock')
  return new Date(row.now)
}

export async function createWorkStreamOrderSnapshot(input: {
  ownerKey: string
  requestFingerprint: string
  snapshotAt: Date
  terminalTotalCount: number
  orderedWorkStreamIds: string[]
}): Promise<WorkStreamOrderSnapshot> {
  return db.transaction(async (tx) => {
    const [snapshot] = await tx
      .insert(workStreamOrderSnapshots)
      .values({
        ownerKey: input.ownerKey,
        requestFingerprint: input.requestFingerprint,
        cursorSecret: randomBytes(32).toString('hex'),
        snapshotAt: input.snapshotAt,
        expiresAt: new Date(input.snapshotAt.getTime() + WORK_STREAM_ORDER_SNAPSHOT_TTL_MS),
        nonTerminalCount: input.orderedWorkStreamIds.length,
        terminalTotalCount: input.terminalTotalCount,
      })
      .returning()
    if (!snapshot) throw new Error('Failed to create work-stream order snapshot')

    for (let offset = 0; offset < input.orderedWorkStreamIds.length; offset += INSERT_CHUNK_SIZE) {
      const ids = input.orderedWorkStreamIds.slice(offset, offset + INSERT_CHUNK_SIZE)
      await tx.insert(workStreamOrderSnapshotItems).values(
        ids.map((workStreamId, index) => ({
          snapshotId: snapshot.id,
          ordinal: offset + index,
          workStreamId,
        }))
      )
    }
    return snapshot
  })
}

export async function getWorkStreamOrderSnapshot(id: string): Promise<WorkStreamOrderSnapshot | null> {
  const [snapshot] = await db
    .select()
    .from(workStreamOrderSnapshots)
    .where(eq(workStreamOrderSnapshots.id, id))
    .limit(1)
  return snapshot ?? null
}

export async function loadWorkStreamOrderSnapshotPage(
  snapshotId: string,
  nextOrdinal: number,
  limit: number
): Promise<{ snapshot: WorkStreamOrderSnapshot; items: Array<{ ordinal: number; workStreamId: string }> } | null> {
  return db.transaction(async (tx) => {
    const [snapshot] = await tx
      .select()
      .from(workStreamOrderSnapshots)
      .where(eq(workStreamOrderSnapshots.id, snapshotId))
      .limit(1)
      .for('share')
    if (!snapshot) return null
    const items = await tx
      .select({
        ordinal: workStreamOrderSnapshotItems.ordinal,
        workStreamId: workStreamOrderSnapshotItems.workStreamId,
      })
      .from(workStreamOrderSnapshotItems)
      .where(
        and(
          eq(workStreamOrderSnapshotItems.snapshotId, snapshotId),
          gte(workStreamOrderSnapshotItems.ordinal, nextOrdinal)
        )
      )
      .orderBy(asc(workStreamOrderSnapshotItems.ordinal))
      .limit(limit)
    return { snapshot, items }
  })
}

export async function cleanupExpiredWorkStreamOrderSnapshots(now = new Date()): Promise<number> {
  const expired = await db
    .select({ id: workStreamOrderSnapshots.id })
    .from(workStreamOrderSnapshots)
    .where(lt(workStreamOrderSnapshots.expiresAt, now))
    .orderBy(asc(workStreamOrderSnapshots.expiresAt))
    .limit(WORK_STREAM_ORDER_SNAPSHOT_CLEANUP_BATCH_SIZE)
  if (expired.length === 0) return 0
  await db.delete(workStreamOrderSnapshots).where(
    inArray(
      workStreamOrderSnapshots.id,
      expired.map((row) => row.id)
    )
  )
  return expired.length
}
