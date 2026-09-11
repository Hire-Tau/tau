import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { db, peers } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { amtpRouter } from './amtp'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem } from '../services/amtp/crypto'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'

const prefix = `fed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser
let plainUser: TestUser

const app = new Hono()
app.use('/api/*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/amtp', amtpRouter)

beforeEach(async () => {
  await db.delete(peers)
  if (!admin) admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  if (!plainUser) plainUser = await createTestUser({ prefix })
})
afterAll(async () => {
  await cleanupTestRbac(prefix)
})

const peerKeys = generateInstanceKeyPair()
const peerInstanceId = instanceIdFromPublicKeyPem(peerKeys.publicKeyPem)

const peerBody = {
  localAlias: 'acme',
  instanceId: peerInstanceId,
  baseUrl: 'https://acme.example/api',
  publicKeyPem: peerKeys.publicKeyPem,
}

describe('federation routes', () => {
  test('GET /amtp/identity is public and returns instanceId + publicKey (not 500)', async () => {
    const res = await app.request('/api/amtp/identity')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.instanceId).toBe('string')
    expect(body.publicKeyPem).toContain('BEGIN PUBLIC KEY')
    expect(body.privateKeyPem).toBeUndefined()
  })

  test('GET /instance-identity requires amtp:read', async () => {
    expect((await app.request('/api/amtp/instance-identity', { headers: authHeaders(plainUser.token) })).status).toBe(
      403
    )
    const ok = await app.request('/api/amtp/instance-identity', { headers: authHeaders(admin.token) })
    expect(ok.status).toBe(200)
  })

  test('peer create/list/update/delete (amtp:write/read)', async () => {
    const created = await app.request('/api/amtp/peers', {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(peerBody),
    })
    expect(created.status).toBe(201)
    const peer = await created.json()

    const list = await app.request('/api/amtp/peers', { headers: authHeaders(admin.token) })
    expect((await list.json()).map((p: any) => p.id)).toEqual([peer.id])

    const patched = await app.request(`/api/amtp/peers/${peer.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    })
    expect((await patched.json()).status).toBe('disabled')

    expect(
      (await app.request(`/api/amtp/peers/${peer.id}`, { method: 'DELETE', headers: authHeaders(admin.token) })).status
    ).toBe(200)
  })

  test('peer write is denied without amtp:write', async () => {
    const res = await app.request('/api/amtp/peers', {
      method: 'POST',
      headers: { ...authHeaders(plainUser.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(peerBody),
    })
    expect(res.status).toBe(403)
  })

  test('duplicate peer POST returns 409', async () => {
    const first = await app.request('/api/amtp/peers', {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(peerBody),
    })
    expect(first.status).toBe(201)
    const second = await app.request('/api/amtp/peers', {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(peerBody),
    })
    expect(second.status).toBe(409)
    expect((await second.json()).error).toBe('Peer already exists')
  })

  test('POST /peers rejects a publicKeyPem/instanceId that do not self-certify (§4.2)', async () => {
    const otherKeys = generateInstanceKeyPair()
    const res = await app.request('/api/amtp/peers', {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...peerBody, publicKeyPem: otherKeys.publicKeyPem }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/instanceId/i)
  })

  test('POST /peers accepts a matching (instanceId, publicKeyPem) pair', async () => {
    const res = await app.request('/api/amtp/peers', {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(peerBody),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.instanceId).toBe(peerInstanceId)
  })

  test('PATCH nonexistent peer returns 404', async () => {
    const res = await app.request('/api/amtp/peers/00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    })
    expect(res.status).toBe(404)
  })

  test('DELETE nonexistent peer returns 404', async () => {
    const res = await app.request('/api/amtp/peers/00000000-0000-0000-0000-000000000000', {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(404)
  })
})
