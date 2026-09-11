import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { amtpRouter } from './amtp'
import { Peer } from '../entities/Peer'
import { authHeaders, assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../test-utils'

const app = new Hono()
app.use('/api/*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/amtp', amtpRouter)

const prefix = `fed-proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let reader: TestUser
let sender: TestUser
let plain: TestUser
let peer: Peer
const originalFetch = globalThis.fetch

beforeAll(async () => {
  reader = await createTestUser({ prefix })
  sender = await createTestUser({ prefix })
  plain = await createTestUser({ prefix })
  const readRole = await createTestRole({ prefix, permissions: ['amtp:read'] })
  const sendRole = await createTestRole({ prefix, permissions: ['amtp:send'] })
  await assignRole({ userId: reader.id, roleId: readRole.id, scope: 'system' })
  await assignRole({ userId: sender.id, roleId: sendRole.id, scope: 'system' })
  peer = await Peer.create({
    localAlias: `${prefix}-alias`,
    instanceId: `${prefix}-instance-0000000000000000000000`,
    baseUrl: 'https://peer.example/api',
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
  })
})

afterAll(async () => {
  await Peer.delete(peer.id)
  await cleanupTestRbac(prefix)
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubPeerResponse(status = 200, body: unknown = { handles: [{ handle: 'alice' }] }) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe('GET /api/amtp/peers/:ref/handles', () => {
  test('unauthenticated → 401', async () => {
    const res = await app.request(`/api/amtp/peers/${peer.id}/handles`)
    expect(res.status).toBe(401)
  })

  test('no amtp:read or amtp:send → 403', async () => {
    const res = await app.request(`/api/amtp/peers/${peer.id}/handles`, { headers: authHeaders(plain.token) })
    expect(res.status).toBe(403)
  })

  test('amtp:read → 200 with the peer handles (by row id)', async () => {
    stubPeerResponse()
    const res = await app.request(`/api/amtp/peers/${peer.id}/handles`, { headers: authHeaders(reader.token) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ handles: [{ handle: 'alice' }] })
  })

  test('amtp:send → 200; :ref resolves by localAlias and by instanceId', async () => {
    stubPeerResponse()
    const byAlias = await app.request(`/api/amtp/peers/${peer.localAlias}/handles`, {
      headers: authHeaders(sender.token),
    })
    expect(byAlias.status).toBe(200)
    stubPeerResponse()
    const byInstance = await app.request(`/api/amtp/peers/${peer.instanceId}/handles`, {
      headers: authHeaders(sender.token),
    })
    expect(byInstance.status).toBe(200)
  })

  test('unknown ref → 404', async () => {
    const res = await app.request('/api/amtp/peers/nope-not-a-peer/handles', {
      headers: authHeaders(reader.token),
    })
    expect(res.status).toBe(404)
  })

  test('inactive peer → 409', async () => {
    await Peer.update(peer.id, { status: 'disabled' })
    const res = await app.request(`/api/amtp/peers/${peer.id}/handles`, { headers: authHeaders(reader.token) })
    expect(res.status).toBe(409)
    await Peer.update(peer.id, { status: 'active' })
  })

  test('peer fetch failure → 502', async () => {
    stubPeerResponse(500, 'down')
    const res = await app.request(`/api/amtp/peers/${peer.id}/handles`, { headers: authHeaders(reader.token) })
    expect(res.status).toBe(502)
  })
})
