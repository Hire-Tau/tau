import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { identityMiddleware } from '../middleware/identity'
import { terminalRouter } from './terminal'
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
app.route('/api/terminal', terminalRouter)

const rbacPrefix = `terminal-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const squadId = '11111111-1111-4111-8111-111111111111'
const otherSquadId = '22222222-2222-4222-8222-222222222222'
const sandboxId = `squad_${squadId}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: rbacPrefix, canonicalAdmin: true })
})

afterAll(async () => {
  await cleanupTestRbac(rbacPrefix)
})

describe('terminal routes', () => {
  it('returns 401 without identity', async () => {
    const res = await app.request(`/api/terminal/sessions?sandboxId=${sandboxId}`)
    expect(res.status).toBe(401)
  })

  it('returns 401 for deleting a session without identity before revealing existence', async () => {
    const res = await app.request('/api/terminal/sessions/missing-session', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  it('denies unresolved sessions for authenticated callers', async () => {
    const res = await app.request('/api/terminal/sessions/missing-session', {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(403)
  })

  it('denies users without terminal access', async () => {
    const user = await createTestUser({ prefix: rbacPrefix })
    const res = await app.request(`/api/terminal/sessions?sandboxId=${sandboxId}`, {
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(403)
  })

  it('denies terminal access outside the assigned squad scope', async () => {
    const user = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ prefix: rbacPrefix, permissions: ['terminal:access'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: otherSquadId })

    const res = await app.request(`/api/terminal/sessions?sandboxId=${sandboxId}`, {
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(403)
  })

  it('allows admins to list sessions for a squad sandbox', async () => {
    const res = await app.request(`/api/terminal/sessions?sandboxId=${sandboxId}`, {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})
