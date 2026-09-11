import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { integrationEventPollingCursors } from '../../db/schema'
import { DbEventPollingCursorStore } from './db-event-polling-cursor-store'

const providerKey = `test-${crypto.randomUUID()}`

afterEach(async () => {
  await db.delete(integrationEventPollingCursors).where(eq(integrationEventPollingCursors.providerKey, providerKey))
})

describe('DbEventPollingCursorStore', () => {
  test('atomically grants only one lease under concurrent runner ticks', async () => {
    const store = new DbEventPollingCursorStore()
    const requestedAt = new Date(0)
    const beforeClaim = Date.now()

    const claims = await Promise.all([
      store.claim(providerKey, 'repo#1', requestedAt, 60_000),
      store.claim(providerKey, 'repo#1', requestedAt, 60_000),
    ])

    expect(claims.filter(Boolean)).toHaveLength(1)
    const claim = claims.find(Boolean)!
    expect(claim.leaseUntil.getTime()).toBeGreaterThan(beforeClaim + 50_000)
    const renewedUntil = await store.renew(providerKey, 'repo#1', claim.leaseToken, 60_000)
    expect(renewedUntil!.getTime()).toBeGreaterThan(Date.now() + 50_000)
    await store.save(providerKey, 'repo#1', claim.leaseToken, { lastSeen: 42 }, new Date(Date.now() + 60_000))
    expect(await store.claim(providerKey, 'repo#1', requestedAt, 60_000)).toBeNull()
  })

  test('fences failure backoff updates by lease token', async () => {
    const store = new DbEventPollingCursorStore()
    const claim = (await store.claim(providerKey, 'repo#failure', new Date(), 60_000))!
    const retryAt = new Date(Date.now() + 60_000)

    expect(await store.fail(providerKey, 'repo#failure', crypto.randomUUID(), retryAt)).toBe(false)
    expect(await store.renew(providerKey, 'repo#failure', claim.leaseToken, 60_000)).not.toBeNull()
    expect(await store.fail(providerKey, 'repo#failure', claim.leaseToken, retryAt)).toBe(true)
    expect(await store.claim(providerKey, 'repo#failure', new Date(), 60_000)).toBeNull()
  })
})
