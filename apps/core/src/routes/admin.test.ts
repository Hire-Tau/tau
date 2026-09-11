import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createAdminRouter } from './admin'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'
import type { NixGcApplyResult, NixGcScan } from '../services/sandbox/docker/nix-gc'

const prefix = `admin-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const scanResult: NixGcScan = {
  candidates: [{ sandboxId: 'agent_x', bytes: 1000, verdict: 'orphaned', running: false }],
  totalReclaimableBytes: 1000,
}
const applyResult: NixGcApplyResult = { ...scanResult, reclaimed: ['agent_x'], failed: [] }

describe('admin routes', () => {
  let admin: TestUser
  let unprivileged: TestUser

  beforeAll(async () => {
    admin = await createTestAdmin({ prefix })
    unprivileged = await createTestUser({ prefix })
  })

  afterAll(async () => {
    await cleanupTestRbac(prefix)
  })

  function authedRouter(deps: Parameters<typeof createAdminRouter>[0] = {}) {
    const app = new Hono()
    app.use('*', identityMiddleware)
    app.route('/', createAdminRouter(deps))
    return app
  }

  function req(body?: unknown, token = admin.token) {
    return {
      method: 'POST',
      headers: { ...authHeaders(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }
  }

  it('401s an unauthenticated caller and 403s one without system:cleanup', async () => {
    const router = authedRouter()
    expect((await router.request('/nix-gc', { method: 'POST', body: JSON.stringify({}) })).status).toBe(401)
    expect((await router.request('/nix-gc', req({}, unprivileged.token))).status).toBe(403)
  })

  it('dry-run (default) scans and never applies', async () => {
    let applied = false
    const router = authedRouter({
      scan: async () => scanResult,
      apply: async () => {
        applied = true
        return applyResult
      },
    })
    const res = await router.request('/nix-gc', req({}))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalReclaimableBytes).toBe(1000)
    expect(body.reclaimed).toBeUndefined()
    expect(applied).toBe(false)
  })

  it('workspace GC requires cleanup permission', async () => {
    const router = authedRouter()
    expect((await router.request('/workspace-gc', { method: 'POST', body: JSON.stringify({}) })).status).toBe(401)
    expect((await router.request('/workspace-gc', req({}, unprivileged.token))).status).toBe(403)
  })

  it('workspace GC defaults to dry-run and forwards bounded options', async () => {
    let captured: unknown
    const router = authedRouter({
      workspaceGc: async (request) => {
        captured = request
        return {
          mode: 'dry-run',
          scanned: 0,
          eligible: 0,
          removed: 0,
          protected: {},
          skipped: {},
          errors: {},
          hasMore: false,
          nextCursor: null,
        }
      },
    })

    const res = await router.request('/workspace-gc', req({ limit: 25 }))
    expect(res.status).toBe(200)
    expect(captured).toEqual({ limit: 25 })
  })

  it('workspace GC validates limits and cursors', async () => {
    const router = authedRouter()
    expect((await router.request('/workspace-gc', req({ limit: 0 }))).status).toBe(400)
    expect((await router.request('/workspace-gc', req({ limit: 5001 }))).status).toBe(400)
    expect((await router.request('/workspace-gc', req({ cursor: '../unsafe' }))).status).toBe(400)
  })

  it('apply:true reclaims via the apply path', async () => {
    let scanned = false
    const router = authedRouter({
      scan: async () => {
        scanned = true
        return scanResult
      },
      apply: async () => applyResult,
    })
    const res = await router.request('/nix-gc', req({ apply: true }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reclaimed).toEqual(['agent_x'])
    expect(body.failed).toEqual([])
    expect(scanned).toBe(false)
  })
})
