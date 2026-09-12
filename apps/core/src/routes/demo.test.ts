import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { identityMiddleware } from '../middleware/identity'
import { DemoSeedError } from '../services/demo/seed'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'
import { createDemoRouter } from './demo'

const prefix = `demo-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

describe('demo routes', () => {
  let admin: TestUser
  let unprivileged: TestUser

  beforeAll(async () => {
    admin = await createTestAdmin({ prefix })
    unprivileged = await createTestUser({ prefix })
  })
  afterAll(async () => {
    await cleanupTestRbac(prefix)
  })

  function router(deps: Parameters<typeof createDemoRouter>[0] = {}) {
    const app = new Hono()
    app.use('*', identityMiddleware)
    app.route('/', createDemoRouter({ enabled: () => true, ...deps }))
    return app
  }
  const post = (token = admin.token) => ({ method: 'POST', headers: authHeaders(token) })

  it('is admin only, and absent unless the instance opted in', async () => {
    const seed = mock(async () => ({ version: 1 }) as never)
    expect((await router({ seed }).request('/seed', { method: 'POST' })).status).toBe(401)
    expect((await router({ seed }).request('/seed', post(unprivileged.token))).status).toBe(403)
    expect((await router({ seed, enabled: () => false }).request('/seed', post())).status).toBe(404)
    expect(seed).not.toHaveBeenCalled()
  })

  it('seeds and reports, and turns a seed precondition into a 409', async () => {
    const summary = { version: 1, created: ['squad Growth'] }
    const ok = await router({ seed: async () => summary as never }).request('/seed', post())
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual(summary)

    const failing = await router({
      seed: async () => {
        throw new DemoSeedError('Role "demo-reviewer" is missing')
      },
    }).request('/seed', post())
    expect(failing.status).toBe(409)
    expect((await failing.json()).error).toContain('demo-reviewer')
  })

  it('revokes reviewer devices', async () => {
    const res = await router({ revokeDevices: async () => 3 }).request('/revoke-devices', post())
    expect(await res.json()).toEqual({ revoked: 3 })
  })
})
