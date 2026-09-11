import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { db } from '../../db'
import { workStreamOrderSnapshotItems, workStreamOrderSnapshots } from '../../db/schema'
import {
  cleanupExpiredWorkStreamOrderSnapshots,
  createWorkStreamOrderSnapshot,
  getWorkStreamOrderSnapshot,
  loadWorkStreamOrderSnapshotPage,
  WORK_STREAM_ORDER_SNAPSHOT_CLEANUP_BATCH_SIZE,
} from './order-snapshots'

afterEach(async () => {
  await db.delete(workStreamOrderSnapshots)
})

describe('durable work-stream order snapshots', () => {
  it('reads bounded ordinal pages in frozen order', async () => {
    const ids = Array.from({ length: 7 }, () => randomUUID())
    const snapshot = await createWorkStreamOrderSnapshot({
      ownerKey: 'user:test',
      requestFingerprint: 'a'.repeat(64),
      snapshotAt: new Date(),
      terminalTotalCount: 2,
      orderedWorkStreamIds: ids,
    })

    expect((await loadWorkStreamOrderSnapshotPage(snapshot.id, 2, 3))?.items).toEqual(
      ids.slice(2, 5).map((workStreamId, index) => ({ ordinal: index + 2, workStreamId }))
    )
  })

  it('orders physically out-of-order snapshot items by ordinal', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    const snapshot = await createWorkStreamOrderSnapshot({
      ownerKey: 'agent:test',
      requestFingerprint: 'f'.repeat(64),
      snapshotAt: new Date(),
      terminalTotalCount: 0,
      orderedWorkStreamIds: [],
    })
    await db.insert(workStreamOrderSnapshotItems).values([
      { snapshotId: snapshot.id, ordinal: 2, workStreamId: ids[2]! },
      { snapshotId: snapshot.id, ordinal: 0, workStreamId: ids[0]! },
      { snapshotId: snapshot.id, ordinal: 1, workStreamId: ids[1]! },
    ])

    expect((await loadWorkStreamOrderSnapshotPage(snapshot.id, 0, 3))?.items.map((item) => item.workStreamId)).toEqual(
      ids
    )
  })

  it('bounds cleanup batches while eventually deleting expired snapshots only', async () => {
    const expired = await Promise.all(
      Array.from({ length: WORK_STREAM_ORDER_SNAPSHOT_CLEANUP_BATCH_SIZE + 5 }, (_, index) =>
        createWorkStreamOrderSnapshot({
          ownerKey: 'legacy',
          requestFingerprint: String(index).padStart(64, '0'),
          snapshotAt: new Date('2026-01-01T00:00:00.000Z'),
          terminalTotalCount: 0,
          orderedWorkStreamIds: [randomUUID()],
        })
      )
    )
    const live = await createWorkStreamOrderSnapshot({
      ownerKey: 'legacy',
      requestFingerprint: 'c'.repeat(64),
      snapshotAt: new Date('2026-01-02T00:00:00.000Z'),
      terminalTotalCount: 0,
      orderedWorkStreamIds: [randomUUID()],
    })

    const cutoff = new Date('2026-01-01T00:31:00.000Z')
    expect(await cleanupExpiredWorkStreamOrderSnapshots(cutoff)).toBe(WORK_STREAM_ORDER_SNAPSHOT_CLEANUP_BATCH_SIZE)
    expect(await cleanupExpiredWorkStreamOrderSnapshots(cutoff)).toBe(5)
    expect(await getWorkStreamOrderSnapshot(expired[0]!.id)).toBeNull()
    expect(await getWorkStreamOrderSnapshot(live.id)).not.toBeNull()
  })

  it('continues from PostgreSQL through a freshly loaded service module', async () => {
    const ids = [randomUUID(), randomUUID()]
    const snapshot = await createWorkStreamOrderSnapshot({
      ownerKey: 'agent:test',
      requestFingerprint: 'd'.repeat(64),
      snapshotAt: new Date(),
      terminalTotalCount: 0,
      orderedWorkStreamIds: ids,
    })
    const fresh = await import(`./order-snapshots.ts?fresh=${randomUUID()}`)
    expect((await fresh.loadWorkStreamOrderSnapshotPage(snapshot.id, 1, 1))?.items).toEqual([
      { ordinal: 1, workStreamId: ids[1] },
    ])
  })

  it('never returns an empty same-position page during concurrent cleanup', async () => {
    const snapshot = await createWorkStreamOrderSnapshot({
      ownerKey: 'legacy',
      requestFingerprint: 'e'.repeat(64),
      snapshotAt: new Date('2026-01-01T00:00:00.000Z'),
      terminalTotalCount: 0,
      orderedWorkStreamIds: [randomUUID()],
    })
    const [loaded] = await Promise.all([
      loadWorkStreamOrderSnapshotPage(snapshot.id, 0, 2),
      cleanupExpiredWorkStreamOrderSnapshots(new Date('2026-01-01T00:31:00.000Z')),
    ])
    expect(loaded === null || loaded.items.length === 1).toBe(true)
  })
})
