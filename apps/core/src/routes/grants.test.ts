import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { like } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, squads, squadMemoryGrants } from '../db'
import { grantsRouter } from './grants'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api', grantsRouter)

const rbacPrefix = `grants-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser
let unprivileged: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: rbacPrefix })
  unprivileged = await createTestUser({ prefix: rbacPrefix })
})

afterAll(async () => {
  await cleanupTestRbac(rbacPrefix)
})

function adminHeaders(contentType = false) {
  return contentType ? { 'Content-Type': 'application/json', ...authHeaders(admin.token) } : authHeaders(admin.token)
}

describe('grant routes', () => {
  let testPrefix: string
  let sourceSquadId: string
  let granteeSquadId: string

  beforeEach(async () => {
    testPrefix = `grant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const created = await db
      .insert(squads)
      .values([
        { name: `${testPrefix} Source`, purpose: 'Source squad', status: 'active' },
        { name: `${testPrefix} Grantee`, purpose: 'Grantee squad', status: 'active' },
      ])
      .returning()

    sourceSquadId = created[0].id
    granteeSquadId = created[1].id
  })

  afterEach(async () => {
    await db.delete(squadMemoryGrants)
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  it('creates, lists issued, lists received, and deletes grants', async () => {
    const createRes = await app.request(`/api/squads/${sourceSquadId}/grants`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({
        granteeSquadId,
        policy: { read: { sourceTypes: ['memory_file'], paths: ['patterns/**'], sensitivity: 'internal' } },
        expiresAt: null,
      }),
    })

    expect(createRes.status).toBe(201)
    const created = await createRes.json()
    expect(created.sourceSquadId).toBe(sourceSquadId)
    expect(created.granteeSquadId).toBe(granteeSquadId)

    const issuedRes = await app.request(`/api/squads/${sourceSquadId}/grants`, { headers: adminHeaders() })
    expect(issuedRes.status).toBe(200)
    const issued = await issuedRes.json()
    expect(issued).toHaveLength(1)
    expect(issued[0].id).toBe(created.id)

    const receivedRes = await app.request(`/api/squads/${granteeSquadId}/granted`, { headers: adminHeaders() })
    expect(receivedRes.status).toBe(200)
    const received = await receivedRes.json()
    expect(received).toHaveLength(1)
    expect(received[0].sourceSquadId).toBe(sourceSquadId)

    const deleteRes = await app.request(`/api/grants/${created.id}`, { method: 'DELETE', headers: adminHeaders() })
    expect(deleteRes.status).toBe(204)

    const issuedAfterDeleteRes = await app.request(`/api/squads/${sourceSquadId}/grants`, { headers: adminHeaders() })
    expect(await issuedAfterDeleteRes.json()).toEqual([])
  })

  it('denies unprivileged grant reads and writes', async () => {
    const createRes = await app.request(`/api/squads/${sourceSquadId}/grants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(unprivileged.token) },
      body: JSON.stringify({ granteeSquadId, policy: {} }),
    })
    expect(createRes.status).toBe(403)

    const readIssuedRes = await app.request(`/api/squads/${sourceSquadId}/grants`, {
      headers: authHeaders(unprivileged.token),
    })
    expect(readIssuedRes.status).toBe(403)

    const readReceivedRes = await app.request(`/api/squads/${granteeSquadId}/granted`, {
      headers: authHeaders(unprivileged.token),
    })
    expect(readReceivedRes.status).toBe(403)
  })

  it('denies unprivileged delete via grant source squad handler-scope check', async () => {
    const grant = await db.insert(squadMemoryGrants).values({ sourceSquadId, granteeSquadId, policy: {} }).returning()

    const res = await app.request(`/api/grants/${grant[0].id}`, {
      method: 'DELETE',
      headers: authHeaders(unprivileged.token),
    })
    expect(res.status).toBe(403)
  })

  it('validates create payloads', async () => {
    const res = await app.request(`/api/squads/${sourceSquadId}/grants`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ granteeSquadId, policy: { read: { sensitivity: 'secret' } } }),
    })

    expect(res.status).toBe(400)
  })
})
