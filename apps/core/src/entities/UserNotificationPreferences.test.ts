import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, userNotificationPreferences } from '../db'
import { UserNotificationPreferences } from './UserNotificationPreferences'
import { cleanupTestRbac, createTestUser, type TestUser } from '../test-utils'

const prefix = `unp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let user: TestUser

beforeAll(async () => {
  user = await createTestUser({ prefix })
})

afterAll(async () => {
  await db.delete(userNotificationPreferences).where(eq(userNotificationPreferences.userId, user.id))
  await cleanupTestRbac(prefix)
})

describe('UserNotificationPreferences', () => {
  it('defaults to push-on with detailed previews / nothing muted when no row exists', async () => {
    const prefs = await UserNotificationPreferences.get(user.id)
    expect(prefs).toEqual({ pushEnabled: true, showPreviews: true, mutedEvents: [] })
    expect(await UserNotificationPreferences.shouldPush(user.id, 'inbox.messageReceived')).toBe(true)
  })

  it('persists detailed defaults and preserves an explicit opt-out through unrelated updates', async () => {
    const [row] = await db.insert(userNotificationPreferences).values({ userId: user.id }).returning()
    expect(row!.showPreviews).toBe(true)
    await UserNotificationPreferences.upsert(user.id, { showPreviews: false })
    await UserNotificationPreferences.upsert(user.id, { pushEnabled: false })
    expect((await UserNotificationPreferences.get(user.id)).showPreviews).toBe(false)
    await UserNotificationPreferences.upsert(user.id, { showPreviews: true, pushEnabled: true })
    expect((await UserNotificationPreferences.get(user.id)).showPreviews).toBe(true)
  })

  it('disabling push suppresses all events', async () => {
    await UserNotificationPreferences.upsert(user.id, { pushEnabled: false })
    expect(await UserNotificationPreferences.shouldPush(user.id, 'inbox.messageReceived')).toBe(false)
    await UserNotificationPreferences.upsert(user.id, { pushEnabled: true })
  })

  it('muting an event suppresses only that event', async () => {
    await UserNotificationPreferences.upsert(user.id, { mutedEvents: ['inbox.messageReceived'] })
    expect(await UserNotificationPreferences.shouldPush(user.id, 'inbox.messageReceived')).toBe(false)
    expect(await UserNotificationPreferences.shouldPush(user.id, 'workStream.blocked')).toBe(true)
  })

  it('upsert merges partial updates', async () => {
    await UserNotificationPreferences.upsert(user.id, { pushEnabled: false })
    const prefs = await UserNotificationPreferences.get(user.id)
    // mutedEvents from the previous test should persist through a pushEnabled-only update
    expect(prefs.pushEnabled).toBe(false)
    expect(prefs.mutedEvents).toEqual(['inbox.messageReceived'])
  })
})
