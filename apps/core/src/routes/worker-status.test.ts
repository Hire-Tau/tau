import { describe, it, expect, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { identityMiddleware, requirePermission } from '../middleware'
import { getWorkerStatus } from '../services/worker'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser } from '../test-utils'

// Mirrors the /api/worker/status route in index.ts, which is gated by
// squads:read (a permission Operators and Viewers hold) instead of the
// previously-undefined 'system:worker-status'.
const app = new Hono()
app.use('*', identityMiddleware)
app.get('/api/worker/status', requirePermission('squads:read'), (c) => c.json({ status: getWorkerStatus() }))

const prefix = `worker-status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

describe('GET /api/worker/status', () => {
  it('returns 401 without identity', async () => {
    expect((await app.request('/api/worker/status')).status).toBe(401)
  })

  it('allows a viewer-like role holding squads:read', async () => {
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['squads:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })
    const res = await app.request('/api/worker/status', { headers: authHeaders(user.token) })
    // Before the fix this required the undefined 'system:worker-status' -> 403.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.status).toBe('string')
  })

  it('denies a role without squads:read', async () => {
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['inbox:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })
    expect((await app.request('/api/worker/status', { headers: authHeaders(user.token) })).status).toBe(403)
  })
})
