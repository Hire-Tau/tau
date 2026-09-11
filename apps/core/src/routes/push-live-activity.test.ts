import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db'
import { liveActivityTokens } from '../db/schema'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestUser, type TestUser } from '../test-utils'
import { pushRouter } from './push'

const prefix = `la-route-${crypto.randomUUID().slice(0, 8)}`

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/push', pushRouter)

let user: TestUser
let other: TestUser
const tokens: string[] = []

function register(body: unknown, as: TestUser) {
  return app.request('/api/push/live-activity', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(as.token) },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  user = await createTestUser({ prefix })
  other = await createTestUser({ prefix })
})

afterAll(async () => {
  for (const token of tokens) await db.delete(liveActivityTokens).where(eq(liveActivityTokens.apnsToken, token))
  await cleanupTestRbac(prefix)
})

describe('GET /api/push/work-interest', () => {
  test('rejects unauthenticated callers and returns the safe aggregate for a user', async () => {
    expect((await app.request('/api/push/work-interest')).status).toBe(401)
    const response = await app.request('/api/push/work-interest', { headers: authHeaders(user.token) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      totalCount: 0,
      top: [],
      liveActivity: { activeCount: 0, needsYouCount: 0, top: [] },
    })
  })
})

describe('POST /api/push/live-activity', () => {
  test('rejects an unauthenticated caller', async () => {
    const response = await app.request('/api/push/live-activity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apnsToken: 'nope', kind: 'start' }),
    })
    expect(response.status).toBe(401)
  })

  test('requires an apnsToken', async () => {
    expect((await register({ kind: 'start' }, user)).status).toBe(400)
  })

  test('rejects a kind outside start|update rather than storing an unroutable row', async () => {
    expect((await register({ apnsToken: 'tok-bad-kind', kind: 'device' }, user)).status).toBe(400)
  })

  // An update token that names no activity can never be targeted at one, so it must not be stored.
  test('requires activityId for an update token', async () => {
    const response = await register({ apnsToken: 'tok-no-activity', kind: 'update' }, user)
    expect(response.status).toBe(400)
    const rows = await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.apnsToken, 'tok-no-activity'))
    expect(rows).toHaveLength(0)
  })

  test('registers an update token', async () => {
    const token = `tok-update-${crypto.randomUUID()}`
    tokens.push(token)
    const response = await register({ apnsToken: token, kind: 'update', activityId: 'act-1' }, user)
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ kind: 'update', activityId: 'act-1' })
  })

  test('registers a start token with no activity binding', async () => {
    const token = `tok-start-${crypto.randomUUID()}`
    tokens.push(token)
    const response = await register({ apnsToken: token, kind: 'start' }, user)
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ kind: 'start', activityId: null })
  })
})

describe('DELETE /api/push/live-activity', () => {
  function unregister(apnsToken: string, as: TestUser) {
    return app.request('/api/push/live-activity', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', ...authHeaders(as.token) },
      body: JSON.stringify({ apnsToken }),
    })
  }

  test('a user cannot delete another user’s token, and the row survives', async () => {
    const token = `tok-scoped-${crypto.randomUUID()}`
    tokens.push(token)
    await register({ apnsToken: token, kind: 'start' }, user)

    expect((await unregister(token, other)).status).toBe(404)
    expect(await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.apnsToken, token))).toHaveLength(1)

    expect((await unregister(token, user)).status).toBe(200)
    expect(await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.apnsToken, token))).toHaveLength(0)
  })

  test('404s an unknown token instead of reporting success', async () => {
    expect((await unregister('tok-never-registered', user)).status).toBe(404)
  })
})
