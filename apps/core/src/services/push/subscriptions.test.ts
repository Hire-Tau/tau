import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq, or } from 'drizzle-orm'
import { db, pushSubscriptions } from '../../db'
import { cleanupTestRbac, createTestUser, type TestUser } from '../../test-utils'
import {
  deletePushSubscriptionIfUnchanged,
  getAllPushSubscriptions,
  getPushSubscription,
  getPushSubscriptionsByUser,
  getPushSubscriptionsByUserWithKeys,
  registerPushSubscription,
} from './subscriptions'

describe('push subscriptions service', () => {
  const prefix = `push-subscriptions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let user: TestUser
  let otherUser: TestUser

  beforeAll(async () => {
    user = await createTestUser({ prefix })
    otherUser = await createTestUser({ prefix })
  })

  afterAll(async () => {
    await cleanupTestRbac(prefix)
  })

  async function deleteTestSubscriptions() {
    await db
      .delete(pushSubscriptions)
      .where(or(eq(pushSubscriptions.userId, user.id), eq(pushSubscriptions.userId, otherUser.id)))
  }

  beforeEach(deleteTestSubscriptions)
  afterEach(deleteTestSubscriptions)

  it('creates a subscription', async () => {
    const sub = await registerPushSubscription({
      endpoint: 'https://push.example.com/abc',
      p256dh: 'test-p256dh-key',
      auth: 'test-auth-secret',
      userAgent: 'Mozilla/5.0 Test',
      userId: user.id,
    })

    expect(sub.id).toBeDefined()
    expect(sub.endpoint).toBe('https://push.example.com/abc')
    expect(sub.userAgent).toBe('Mozilla/5.0 Test')
  })

  it('refreshes the same endpoint in one stable row', async () => {
    const input = {
      endpoint: 'https://push.example.com/refresh',
      p256dh: 'old-key',
      auth: 'old-auth',
      userAgent: 'old-agent',
      userId: user.id,
    }
    const first = await registerPushSubscription(input)
    const refreshed = await registerPushSubscription({
      ...input,
      p256dh: 'new-key',
      auth: 'new-auth',
      userAgent: 'new-agent',
    })

    const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, input.endpoint))
    expect(rows).toHaveLength(1)
    expect(refreshed.id).toBe(first.id)
    expect(rows[0]).toMatchObject({
      userId: user.id,
      p256dh: 'new-key',
      auth: 'new-auth',
      userAgent: 'new-agent',
    })
  })

  it('atomically transfers an endpoint without changing unrelated subscriptions', async () => {
    const endpoint = 'https://push.example.com/transfer'
    const former = await registerPushSubscription({
      endpoint,
      p256dh: 'former-key',
      auth: 'former-auth',
      userAgent: 'former-agent',
      userId: user.id,
    })
    const [unrelated] = await db
      .insert(pushSubscriptions)
      .values({
        endpoint: 'https://push.example.com/unrelated',
        p256dh: 'unrelated-key',
        auth: 'unrelated-auth',
        userAgent: 'unrelated-agent',
        userId: user.id,
      })
      .returning()

    const current = await registerPushSubscription({
      endpoint,
      p256dh: 'current-key',
      auth: 'current-auth',
      userAgent: 'current-agent',
      userId: otherUser.id,
    })

    expect(current.id).toBe(former.id)
    expect(await getPushSubscriptionsByUser(user.id)).toEqual([
      expect.objectContaining({ id: unrelated.id, endpoint: unrelated.endpoint }),
    ])
    expect(await getPushSubscriptionsByUser(otherUser.id)).toEqual([
      expect.objectContaining({ id: former.id, endpoint }),
    ])
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, unrelated.id))).toEqual([unrelated])
  })

  it('concurrent registrations converge to one complete owner snapshot', async () => {
    const endpoint = 'https://push.example.com/concurrent'
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      endpoint,
      userId: index % 2 ? user.id : otherUser.id,
      p256dh: `key-${index}`,
      auth: `auth-${index}`,
      userAgent: `agent-${index}`,
    }))

    await Promise.all(candidates.map(registerPushSubscription))

    const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))
    expect(rows).toHaveLength(1)
    expect(candidates).toContainEqual(
      expect.objectContaining({
        userId: rows[0].userId,
        p256dh: rows[0].p256dh,
        auth: rows[0].auth,
        userAgent: rows[0].userAgent,
      })
    )
  })

  it('gets a subscription by id', async () => {
    const created = await registerPushSubscription({
      endpoint: 'https://push.example.com/xyz',
      p256dh: 'key',
      auth: 'auth',
      userId: user.id,
    })

    const found = await getPushSubscription(created.id)

    expect(found).not.toBeNull()
    expect(found!.endpoint).toBe('https://push.example.com/xyz')
  })

  it('returns null for a non-existent subscription', async () => {
    expect(await getPushSubscription('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('lists all subscriptions', async () => {
    await registerPushSubscription({ endpoint: 'https://a.com', p256dh: 'k', auth: 'a', userId: user.id })
    await registerPushSubscription({ endpoint: 'https://b.com', p256dh: 'k', auth: 'a', userId: otherUser.id })

    expect(await getAllPushSubscriptions()).toHaveLength(2)
  })

  it('lists subscriptions by user', async () => {
    await registerPushSubscription({ endpoint: 'https://a.com', p256dh: 'k', auth: 'a', userId: user.id })
    await registerPushSubscription({ endpoint: 'https://b.com', p256dh: 'k', auth: 'a', userId: otherUser.id })

    const own = await getPushSubscriptionsByUser(user.id)

    expect(own.map((sub) => sub.endpoint)).toEqual(['https://a.com'])
  })

  it('does not clean up a subscription after only its owner changes', async () => {
    const endpoint = 'https://push.example.com/cleanup-owner'
    await registerPushSubscription({ endpoint, p256dh: 'same-key', auth: 'same-auth', userId: user.id })
    const [oldSnapshot] = await getPushSubscriptionsByUserWithKeys(user.id)

    await registerPushSubscription({ endpoint, p256dh: 'same-key', auth: 'same-auth', userId: otherUser.id })

    expect(await deletePushSubscriptionIfUnchanged(oldSnapshot)).toBe(false)
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))).toEqual([
      expect.objectContaining({ id: oldSnapshot.id, userId: otherUser.id }),
    ])
  })

  it('does not clean up a subscription after only its p256dh changes', async () => {
    const endpoint = 'https://push.example.com/cleanup-p256dh'
    await registerPushSubscription({ endpoint, p256dh: 'old-key', auth: 'same-auth', userId: user.id })
    const [oldSnapshot] = await getPushSubscriptionsByUserWithKeys(user.id)

    await registerPushSubscription({ endpoint, p256dh: 'new-key', auth: 'same-auth', userId: user.id })

    expect(await deletePushSubscriptionIfUnchanged(oldSnapshot)).toBe(false)
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))).toEqual([
      expect.objectContaining({ id: oldSnapshot.id, p256dh: 'new-key' }),
    ])
  })

  it('does not clean up a subscription after only its auth changes', async () => {
    const endpoint = 'https://push.example.com/cleanup-auth'
    await registerPushSubscription({ endpoint, p256dh: 'same-key', auth: 'old-auth', userId: user.id })
    const [oldSnapshot] = await getPushSubscriptionsByUserWithKeys(user.id)

    await registerPushSubscription({ endpoint, p256dh: 'same-key', auth: 'new-auth', userId: user.id })

    expect(await deletePushSubscriptionIfUnchanged(oldSnapshot)).toBe(false)
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))).toEqual([
      expect.objectContaining({ id: oldSnapshot.id, auth: 'new-auth' }),
    ])
  })

  it('cleans up only the exact subscription when another endpoint has identical keys', async () => {
    await registerPushSubscription({
      endpoint: 'https://push.example.com/cleanup-exact',
      p256dh: 'shared-key',
      auth: 'shared-auth',
      userId: user.id,
    })
    await registerPushSubscription({
      endpoint: 'https://push.example.com/cleanup-unrelated',
      p256dh: 'shared-key',
      auth: 'shared-auth',
      userId: user.id,
    })
    const snapshots = await getPushSubscriptionsByUserWithKeys(user.id)
    const exact = snapshots.find(({ endpoint }) => endpoint.endsWith('/cleanup-exact'))!
    const unrelated = snapshots.find(({ endpoint }) => endpoint.endsWith('/cleanup-unrelated'))!

    expect(await deletePushSubscriptionIfUnchanged(exact)).toBe(true)
    expect(await db.select().from(pushSubscriptions)).toEqual([
      expect.objectContaining({ id: unrelated.id, endpoint: unrelated.endpoint }),
    ])
  })
})
