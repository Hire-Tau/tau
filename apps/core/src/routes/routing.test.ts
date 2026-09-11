import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { like } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, squads } from '../db'
import { routingRouter } from './routing'
import { identityMiddleware } from '../middleware/identity'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/routing', routingRouter)

const rbacPrefix = `routing-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: rbacPrefix })
})

afterAll(async () => {
  await cleanupTestRbac(rbacPrefix)
})

function adminHeaders() {
  return authHeaders(admin.token)
}

describe('GET /api/routing/:squadId/suggest-squad', () => {
  let testPrefix: string

  beforeEach(() => {
    testPrefix = `routing-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  })

  afterEach(async () => {
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  it('returns ranked suggestions and recommendation for a question', async () => {
    const [billing] = await db
      .insert(squads)
      .values({ name: `${testPrefix} Billing`, purpose: 'Invoicing and refunds.', status: 'active' })
      .returning()

    const res = await app.request(
      `/api/routing/${billing.id}/suggest-squad?question=${encodeURIComponent('refund an invoice')}`,
      { headers: adminHeaders() }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      suggestions: Array<{ squadId: string }>
      recommendation: string
      confidence: number
      reason: string
    }
    expect(body.suggestions[0].squadId).toBe(billing.id)
    expect(body.recommendation).toBe('route')
    expect(body.confidence).toBeGreaterThan(0)
    expect(body.reason).toEqual(expect.any(String))
  })

  it('returns structured evidence and backwards-compatible reasons', async () => {
    const [billing] = await db
      .insert(squads)
      .values({ name: `${testPrefix} Billing`, purpose: 'Invoicing and refunds.', status: 'active' })
      .returning()

    const res = await app.request(
      `/api/routing/${billing.id}/suggest-squad?question=${encodeURIComponent('refund an invoice')}`,
      { headers: adminHeaders() }
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      suggestions: Array<{ evidence: Array<{ kind: string; score: number }>; reasons: string[] }>
    }
    expect(body.suggestions[0].evidence).toBeInstanceOf(Array)
    expect(body.suggestions[0].evidence[0]).toMatchObject({ kind: expect.any(String), score: expect.any(Number) })
    expect(body.suggestions[0].reasons).toEqual(expect.arrayContaining([expect.any(String)]))
  })

  it('denies routing reads for a squad outside the caller scoped role', async () => {
    const [allowedSquad, deniedSquad] = await db
      .insert(squads)
      .values([
        { name: `${testPrefix} Allowed`, purpose: 'Allowed', status: 'active' },
        { name: `${testPrefix} Denied`, purpose: 'Denied', status: 'active' },
      ])
      .returning()
    const reader = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ prefix: rbacPrefix, permissions: ['routing:read'] })
    await assignRole({ userId: reader.id, roleId: role.id, scope: 'squad', squadId: allowedSquad.id })

    const res = await app.request(
      `/api/routing/${deniedSquad.id}/suggest-squad?question=${encodeURIComponent('refund an invoice')}`,
      { headers: authHeaders(reader.token) }
    )

    expect(res.status).toBe(403)
  })

  it('404s for an unknown squad', async () => {
    const res = await app.request('/api/routing/00000000-0000-0000-0000-000000000000/suggest-squad?question=hi', {
      headers: adminHeaders(),
    })
    expect(res.status).toBe(404)
  })

  it('400s when question is missing', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${testPrefix} X`, purpose: 'Test', status: 'active' })
      .returning()

    const res = await app.request(`/api/routing/${squad.id}/suggest-squad`, { headers: adminHeaders() })
    expect(res.status).toBe(400)
  })
})
