import { describe, test, expect, beforeEach } from 'bun:test'
import { db, amtpReceived } from '../db'
import { AmtpReceived } from './AmtpReceived'

beforeEach(async () => {
  await db.delete(amtpReceived)
})

describe('AmtpReceived', () => {
  test('records a first sighting as new', async () => {
    expect(await AmtpReceived.recordIfNew('peer-a', 'env-1')).toBe(true)
  })

  test('rejects a duplicate (same peer + envelope id) as not new', async () => {
    expect(await AmtpReceived.recordIfNew('peer-a', 'env-1')).toBe(true)
    expect(await AmtpReceived.recordIfNew('peer-a', 'env-1')).toBe(false)
  })

  test('same envelope id from a different peer is new', async () => {
    expect(await AmtpReceived.recordIfNew('peer-a', 'env-1')).toBe(true)
    expect(await AmtpReceived.recordIfNew('peer-b', 'env-1')).toBe(true)
  })

  test('unrecord releases a claimed slot so recordIfNew returns true again', async () => {
    expect(await AmtpReceived.recordIfNew('peer-a', 'env-1')).toBe(true)
    expect(await AmtpReceived.recordIfNew('peer-a', 'env-1')).toBe(false)
    await AmtpReceived.unrecord('peer-a', 'env-1')
    expect(await AmtpReceived.recordIfNew('peer-a', 'env-1')).toBe(true)
  })

  test('pruneOld deletes rows older than the cutoff, keeps the boundary and newer (strict lt)', async () => {
    const now = new Date('2026-06-30T12:00:00.000Z')
    const olderThanMs = 10 * 60 * 1000
    const cutoff = new Date(now.getTime() - olderThanMs)
    await db.insert(amtpReceived).values([
      { peerInstanceId: 'peer-a', envelopeId: 'old', receivedAt: new Date(cutoff.getTime() - 1000) }, // before cutoff → deleted
      { peerInstanceId: 'peer-a', envelopeId: 'edge', receivedAt: cutoff }, // == cutoff → kept (strict lt)
      { peerInstanceId: 'peer-a', envelopeId: 'fresh', receivedAt: new Date(now.getTime() - 60 * 1000) }, // within window → kept
    ])

    await AmtpReceived.pruneOld(olderThanMs, now)

    const remaining = (await db.select().from(amtpReceived)).map((r) => r.envelopeId).sort()
    expect(remaining).toEqual(['edge', 'fresh'])
  })
})
