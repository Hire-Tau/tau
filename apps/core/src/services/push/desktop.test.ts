import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import { db, desktopNotifications } from '../../db'
import { cleanupTestRbac, createTestUser, type TestUser } from '../../test-utils'
import { UserNotificationPreferences } from '../../entities/UserNotificationPreferences'
import { enqueueDesktopNotifications, listDesktopNotifications } from './desktop'
import { Hono } from 'hono'
import { pushRouter } from '../../routes/push'

const prefix = `desktop-notifications-${crypto.randomUUID()}`
let user: TestUser, other: TestUser
beforeAll(async () => {
  user = await createTestUser({ prefix })
  other = await createTestUser({ prefix })
})
afterAll(async () => {
  await db.delete(desktopNotifications).where(inArray(desktopNotifications.userId, [user.id, other.id]))
  await cleanupTestRbac(prefix)
})
test('desktop alerts are user scoped, bounded by retention, and obey current privacy and mute preferences', async () => {
  const item = {
    eventKey: 'one',
    eventType: 'inbox.messageReceived',
    category: 'message',
    title: 'Private title',
    body: 'Private body',
    url: '/inbox',
  }
  await db.insert(desktopNotifications).values([
    { ...item, userId: user.id },
    { ...item, userId: other.id },
    { ...item, userId: user.id, eventKey: 'old', createdAt: sql`now() - interval '8 days'` },
  ])
  expect(await listDesktopNotifications(user.id)).toHaveLength(1)
  await UserNotificationPreferences.upsert(user.id, { showPreviews: false })
  expect((await listDesktopNotifications(user.id))[0]).toMatchObject({
    title: 'Tau update',
    body: 'Open Tau to see your update.',
  })
  await UserNotificationPreferences.upsert(user.id, { mutedEvents: ['message'] })
  expect(await listDesktopNotifications(user.id)).toEqual([])
  await UserNotificationPreferences.upsert(user.id, { mutedEvents: [], pushEnabled: false })
  expect(await listDesktopNotifications(user.id)).toEqual([])
  expect(await listDesktopNotifications(other.id)).toHaveLength(1)
  expect(await db.select().from(desktopNotifications).where(eq(desktopNotifications.userId, user.id))).toHaveLength(2)
})
test('enqueue is managed-only and deduplicates a repeated notification event', async () => {
  const previous = process.env.TAU_DESKTOP_MANAGED
  const event = {
    type: 'inbox',
    messageId: crypto.randomUUID(),
    title: 'Once',
    body: 'An update',
    timestamp: new Date(),
  }
  try {
    delete process.env.TAU_DESKTOP_MANAGED
    await enqueueDesktopNotifications([other.id], event, 'inbox.messageReceived', 'message')
    expect((await listDesktopNotifications(other.id)).filter((row) => row.title === 'Once')).toHaveLength(0)
    process.env.TAU_DESKTOP_MANAGED = '1'
    await enqueueDesktopNotifications([other.id, other.id], event, 'inbox.messageReceived', 'message')
    await enqueueDesktopNotifications([other.id], event, 'inbox.messageReceived', 'message')
    expect((await listDesktopNotifications(other.id)).filter((row) => row.title === 'Once')).toHaveLength(1)
  } finally {
    if (previous === undefined) delete process.env.TAU_DESKTOP_MANAGED
    else process.env.TAU_DESKTOP_MANAGED = previous
  }
})
test('desktop notification endpoint derives its user from the human session, never query parameters', async () => {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('identity', { type: 'user', userId: other.id })
    await next()
  })
  app.route('/push', pushRouter)
  const response = await app.request(`/push/desktop?userId=${user.id}`)
  expect(response.status).toBe(200)
  expect((await response.json()).userId).toBe(other.id)
  const unauthenticated = new Hono().route('/push', pushRouter)
  expect((await unauthenticated.request('/push/desktop')).status).toBe(401)
})
