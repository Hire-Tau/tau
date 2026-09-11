import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../test-utils/maintenance-test-isolation'
import { Hono } from 'hono'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'
import { maintenanceStore } from '../services/maintenance'
import { db, instanceMaintenanceAudit, instanceMaintenanceState } from '../db'
import { createSystemToken } from '../services/auth/system-tokens'
import systemRouter, { setSignalMaintenanceForTests } from './system'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
beforeAll(async () => {
  releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()
})
afterAll(() => releaseMaintenanceIsolation?.())

const prefix = `system-pause-${Date.now()}`
const app = new Hono().use('*', identityMiddleware).route('/api/system', systemRouter)
let admin: TestUser
let user: TestUser

beforeAll(async () => {
  await maintenanceStore.initialize()
  admin = await createTestAdmin({ prefix })
  user = await createTestUser({ prefix })
})

async function resetMaintenanceFixture(): Promise<void> {
  await db.insert(instanceMaintenanceState).values({ id: 'global' }).onConflictDoNothing()
  await db.update(instanceMaintenanceState).set({
    adminHold: false,
    adminReason: null,
    adminHeldAt: null,
    adminHeldBy: null,
    platformLeaseId: null,
    platformLeaseOwnerTokenId: null,
    platformLeaseHolder: null,
    platformLeaseAcquiredAt: null,
    platformLeaseExpiresAt: null,
  })
  await maintenanceStore.refresh()
}

beforeEach(async () => {
  await resetMaintenanceFixture()
  expect((await maintenanceStore.read()).effective).toBe(false)
})

afterEach(async () => {
  await resetMaintenanceFixture()
  expect((await maintenanceStore.read()).effective).toBe(false)
})
afterAll(async () => {
  await maintenanceStore.setAdminHold({ active: false, actor: 'test-cleanup' })
  await cleanupTestRbac(prefix)
})

describe('system pause routes', () => {
  it('initializes a missing singleton before reads and concurrent mutations', async () => {
    await db.delete(instanceMaintenanceAudit)
    await db.delete(instanceMaintenanceState)

    const initial = await app.request('/api/system/pause', { headers: authHeaders(admin.token) })
    expect(initial.status).toBe(200)
    expect(await initial.json()).toEqual({
      effective: false,
      phase: 'active',
    })

    await db.delete(instanceMaintenanceAudit)
    await db.delete(instanceMaintenanceState)
    const { token } = await createSystemToken({ name: 'platform-init-race', scopes: ['system:pause'] })
    const leaseId = '00000000-0000-4000-8000-000000000012'
    const [adminResponse, leaseResponse] = await Promise.all([
      app.request('/api/system/pause/admin', {
        method: 'PUT',
        headers: { ...authHeaders(admin.token), 'content-type': 'application/json' },
        body: JSON.stringify({ active: true, reason: 'init race' }),
      }),
      app.request(`/api/system/pause/platform-lease/${leaseId}`, {
        method: 'PUT',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ holder: 'init-race', ttlSeconds: 300 }),
      }),
    ])
    expect(adminResponse.status).toBe(200)
    expect(leaseResponse.status).toBe(200)
    expect(await maintenanceStore.read()).toMatchObject({
      effective: true,
      generation: 1,
      adminHold: { active: true },
      platformLease: { active: true, leaseId },
    })

    await app.request(`/api/system/pause/platform-lease/${leaseId}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    })
    await maintenanceStore.setAdminHold({ active: false, actor: 'test-cleanup' })
  })

  it('allows every authenticated identity to read but not anonymous callers', async () => {
    expect((await app.request('/api/system/pause')).status).toBe(401)
    expect((await app.request('/api/system/pause', { headers: authHeaders(user.token) })).status).toBe(200)
  })

  it('returns the committed pause snapshot when best-effort signaling fails', async () => {
    setSignalMaintenanceForTests(async () => {
      throw new Error('notify unavailable')
    })
    try {
      const response = await app.request('/api/system/pause/admin', {
        method: 'PUT',
        headers: { ...authHeaders(admin.token), 'content-type': 'application/json' },
        body: JSON.stringify({ active: true, reason: 'signal failure test' }),
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.adminHold.active).toBe(true)
      const state = await maintenanceStore.read()
      expect(state.adminHold.active).toBe(true)
      const auditRows = await db.select().from(instanceMaintenanceAudit).orderBy(instanceMaintenanceAudit.createdAt)
      expect(auditRows.at(-1)).toMatchObject({
        action: 'admin_acquired',
        generation: state.generation,
        effective: state.effective,
      })
    } finally {
      setSignalMaintenanceForTests()
      await maintenanceStore.setAdminHold({ active: false, actor: 'test-cleanup' })
    }
  })

  it('requires system:pause and rejects system tokens for the admin hold', async () => {
    expect(
      (
        await app.request('/api/system/pause/admin', {
          method: 'PUT',
          headers: { ...authHeaders(user.token), 'content-type': 'application/json' },
          body: JSON.stringify({ active: true }),
        })
      ).status
    ).toBe(403)

    const allowed = await app.request('/api/system/pause/admin', {
      method: 'PUT',
      headers: { ...authHeaders(admin.token), 'content-type': 'application/json' },
      body: JSON.stringify({ active: true, reason: 'test' }),
    })
    expect(allowed.status).toBe(200)
  })

  it('returns 400 for malformed or empty maintenance mutation bodies without mutating state', async () => {
    await maintenanceStore.setAdminHold({ active: false, actor: 'test-cleanup' })
    for (const body of ['{', '']) {
      const response = await app.request('/api/system/pause/admin', {
        method: 'PUT',
        headers: { ...authHeaders(admin.token), 'content-type': 'application/json' },
        body,
      })
      expect(response.status).toBe(400)
      expect((await maintenanceStore.read()).adminHold.active).toBe(false)
    }

    const { token } = await createSystemToken({ name: 'platform-malformed-json', scopes: ['system:pause'] })
    const leaseId = '00000000-0000-4000-8000-000000000011'
    for (const body of ['{', '']) {
      const response = await app.request(`/api/system/pause/platform-lease/${leaseId}`, {
        method: 'PUT',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body,
      })
      expect(response.status).toBe(400)
      expect((await maintenanceStore.read()).platformLease.active).toBe(false)
    }
  })

  it('allows only scoped system tokens to own platform leases', async () => {
    const { token } = await createSystemToken({ name: 'platform-orchestrator', scopes: ['system:pause'] })
    const leaseId = '00000000-0000-4000-8000-000000000010'
    const acquired = await app.request(`/api/system/pause/platform-lease/${leaseId}`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ holder: 'resize-machine-host:test', ttlSeconds: 300 }),
    })
    expect(acquired.status).toBe(200)
    const released = await app.request(`/api/system/pause/platform-lease/${leaseId}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    })
    expect(released.status).toBe(200)
  })

  // The two holders are not interchangeable. A platform lease expires on its own
  // (TTL <= 600s), so a platform job that dies mid-maintenance always releases;
  // the administrator hold has NO expiry and is cleared only by a human. Letting
  // the platform's own token set the hold would turn a crashed job into a pause
  // nothing can time out — so `system:pause` must not be sufficient here.
  it('refuses a system token the TTL-less administrator hold even with system:pause', async () => {
    const { token } = await createSystemToken({ name: 'platform-orchestrator', scopes: ['system:pause'] })
    // Order-independent: start from a known-released hold so `false` below can
    // only mean the refused request changed nothing.
    await maintenanceStore.setAdminHold({ active: false, actor: 'test-setup' })
    const refused = await app.request('/api/system/pause/admin', {
      method: 'PUT',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ active: true, reason: 'platform should not be able to do this' }),
    })
    expect(refused.status).toBe(403)
    expect((await maintenanceStore.read()).adminHold.active).toBe(false)
  })
})
