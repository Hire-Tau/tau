import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, channelInstances, channelLinkChallenges, channelIdentityLinks } from '../db'
import { channelLinksRouter } from './channel-links'
import { identityMiddleware } from '../middleware/identity'
import { createTestUser, cleanupTestRbac, authHeaders, type TestUser } from '../test-utils'
import { claimChannelLink } from '../services/channel-access'

const prefix = `channel-links-${crypto.randomUUID()}`
let alice: TestUser
let bob: TestUser
const app = new Hono().use('*', identityMiddleware).route('/links', channelLinksRouter)
beforeAll(async () => {
  alice = await createTestUser({ prefix })
  bob = await createTestUser({ prefix })
  await db.insert(channelInstances).values({ id: prefix, name: 'Test Slack', provider: 'slack' })
})
afterAll(async () => {
  await db.delete(channelInstances).where(eq(channelInstances.id, prefix))
  await cleanupTestRbac(prefix)
})
const request = (user: TestUser, path = '/links', method = 'GET') =>
  app.request(path, { method, headers: authHeaders(user.token) })

describe('personal channel links', () => {
  test('signed-in users need no channel administration permission to link; other accounts cannot see or confirm proofs', async () => {
    const started = await request(alice, '/links', 'POST')
    expect(started.status).toBe(201)
    const challenge = await started.json()
    expect(challenge.code).toHaveLength(32)
    const mine = await (await request(alice)).json()
    expect(JSON.stringify(mine)).not.toContain(challenge.code)
    expect(JSON.stringify(mine)).not.toContain('tokenHash')
    expect(mine.pending.some((p: any) => p.id === challenge.id)).toBe(true)
    expect((await (await request(bob)).json()).pending).toHaveLength(0)
    await request(bob, `/links/${challenge.id}`, 'DELETE')
    expect(await claimChannelLink(prefix, 'sender', 'Alice on Slack', challenge.code)).toBe(true)
    expect((await request(bob, `/links/${challenge.id}/confirm`, 'POST')).status).toBe(409)
    const confirmed = await request(alice, `/links/${challenge.id}/confirm`, 'POST')
    expect(confirmed.status).toBe(200)
    const { id } = await confirmed.json()
    await request(bob, `/links/${id}`, 'DELETE')
    expect(await db.select().from(channelIdentityLinks).where(eq(channelIdentityLinks.id, id))).toHaveLength(1)
    await request(alice, `/links/${id}`, 'DELETE')
    expect(await db.select().from(channelIdentityLinks).where(eq(channelIdentityLinks.id, id))).toHaveLength(0)
  })
  test('cancelling a proof prevents subsequent claims', async () => {
    const challenge = await (await request(alice, '/links', 'POST')).json()
    await request(alice, `/links/${challenge.id}`, 'DELETE')
    expect(await claimChannelLink(prefix, 'sender', 'Alice', challenge.code)).toBe(false)
    expect(
      await db.select().from(channelLinkChallenges).where(eq(channelLinkChallenges.id, challenge.id))
    ).toHaveLength(0)
  })
  test('unauthenticated callers cannot create or read links', async () => {
    expect((await app.request('/links')).status).toBe(401)
    expect((await app.request('/links', { method: 'POST' })).status).toBe(401)
  })
})
