import { describe, test, expect, beforeEach, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { db, agentTypes, squadPresets } from '../db'
import { AgentType } from '../entities/AgentType'
import { SquadPreset } from '../entities/SquadPreset'
import { squadPresetsRouter } from './squad-presets'
import { identityMiddleware } from '../middleware/identity'
import { createTestAdmin, createTestUser, authHeaders, cleanupTestRbac } from '../test-utils'
import type { TestUser } from '../test-utils/rbac'

// ── Shared app with identity middleware ──
const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/squad-presets', squadPresetsRouter)

// ── Functional tests (use canonical admin for auth) ──────────────────────────

describe('squad preset route validation', () => {
  const funcPrefix = `st-func-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let funcAdmin: TestUser

  beforeAll(async () => {
    funcAdmin = await createTestAdmin({ prefix: funcPrefix, canonicalAdmin: true })
  })

  afterAll(async () => {
    await cleanupTestRbac(funcPrefix)
  })

  beforeEach(async () => {
    await db.delete(squadPresets)
    await db.delete(agentTypes)
    AgentType.invalidateCache()
    SquadPreset.invalidateCache()
    await AgentType.upsert({ id: 'worker', name: 'Worker', model: 'openai/gpt-4.1', systemPrompt: 'Work.' })
  })

  test('rejects missing default agent references', async () => {
    const res = await app.request('/api/squad-presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
      body: JSON.stringify({ id: 'custom-squad', name: 'Custom Squad', defaultAgents: ['missing'] }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Agent type "missing" does not exist' })
  })

  test('creates squad preset with valid agent references', async () => {
    const res = await app.request('/api/squad-presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
      body: JSON.stringify({ id: 'custom-squad', name: 'Custom Squad', defaultAgents: ['worker'] }),
    })
    expect(res.status).toBe(201)
    expect((await res.json()).defaultAgents).toEqual(['worker'])
  })
})

// ── RBAC guard tests ──────────────────────────────────────────────────────────

describe('squad-presets RBAC guards', () => {
  const rbacPrefix = `st-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let admin: TestUser
  let unprivileged: TestUser

  beforeAll(async () => {
    admin = await createTestAdmin({ prefix: rbacPrefix, canonicalAdmin: true })
    unprivileged = await createTestUser({ prefix: rbacPrefix })
    // Seed a known squad preset for read/update/delete tests
    await db.delete(squadPresets)
    await db.delete(agentTypes)
    AgentType.invalidateCache()
    SquadPreset.invalidateCache()
    await AgentType.upsert({ id: 'guard-worker', name: 'Guard Worker', model: 'openai/gpt-4.1', systemPrompt: 'G.' })
    await SquadPreset.upsert({ id: 'guard-squad', name: 'Guard Squad', defaultAgents: ['guard-worker'] })
  })

  afterAll(async () => {
    await cleanupTestRbac(rbacPrefix)
    await db.delete(squadPresets)
    await db.delete(agentTypes)
    AgentType.invalidateCache()
    SquadPreset.invalidateCache()
  })

  async function gfetch(
    token: string | null,
    path: string,
    init?: { method?: string; body?: unknown }
  ): Promise<Response> {
    const headers: Record<string, string> = {}
    if (token) Object.assign(headers, authHeaders(token))
    if (init?.body) headers['content-type'] = 'application/json'
    return app.fetch(
      new Request(`http://localhost${path}`, {
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.stringify(init.body) : undefined,
        headers,
      })
    )
  }

  // GET / — squad-presets:read
  test('GET /api/squad-presets → 401 without identity', async () => {
    const res = await gfetch(null, '/api/squad-presets')
    expect(res.status).toBe(401)
  })
  test('GET /api/squad-presets → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/squad-presets')
    expect(res.status).toBe(403)
  })
  test('GET /api/squad-presets → 200 for admin', async () => {
    const res = await gfetch(admin.token, '/api/squad-presets')
    expect(res.status).toBe(200)
  })

  // GET /:id — squad-presets:read
  test('GET /api/squad-presets/:id → 401 without identity', async () => {
    const res = await gfetch(null, '/api/squad-presets/guard-squad')
    expect(res.status).toBe(401)
  })
  test('GET /api/squad-presets/:id → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/squad-presets/guard-squad')
    expect(res.status).toBe(403)
  })
  test('GET /api/squad-presets/:id → 200 for admin', async () => {
    const res = await gfetch(admin.token, '/api/squad-presets/guard-squad')
    expect(res.status).toBe(200)
  })

  // POST / — squad-presets:create
  test('POST /api/squad-presets → 401 without identity', async () => {
    const res = await gfetch(null, '/api/squad-presets', {
      method: 'POST',
      body: { id: 'x', name: 'X' },
    })
    expect(res.status).toBe(401)
  })
  test('POST /api/squad-presets → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/squad-presets', {
      method: 'POST',
      body: { id: 'x', name: 'X' },
    })
    expect(res.status).toBe(403)
  })

  // PUT /:id — squad-presets:update
  test('PUT /api/squad-presets/:id → 401 without identity', async () => {
    const res = await gfetch(null, '/api/squad-presets/guard-squad', {
      method: 'PUT',
      body: { name: 'G' },
    })
    expect(res.status).toBe(401)
  })
  test('PUT /api/squad-presets/:id → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/squad-presets/guard-squad', {
      method: 'PUT',
      body: { name: 'G' },
    })
    expect(res.status).toBe(403)
  })

  // DELETE /:id — squad-presets:delete
  test('DELETE /api/squad-presets/:id → 401 without identity', async () => {
    const res = await gfetch(null, '/api/squad-presets/guard-squad', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })
  test('DELETE /api/squad-presets/:id → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/squad-presets/guard-squad', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  // GET /:id/template-diff — squad-presets:read
  test('GET /api/squad-presets/:id/template-diff → 401 without identity', async () => {
    const res = await gfetch(null, '/api/squad-presets/guard-squad/template-diff')
    expect(res.status).toBe(401)
  })
  test('GET /api/squad-presets/:id/template-diff → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/squad-presets/guard-squad/template-diff')
    expect(res.status).toBe(403)
  })

  // POST /:id/revert-to-template — squad-presets:update
  test('POST /api/squad-presets/:id/revert-to-template → 401 without identity', async () => {
    const res = await gfetch(null, '/api/squad-presets/guard-squad/revert-to-template', { method: 'POST', body: {} })
    expect(res.status).toBe(401)
  })
  test('POST /api/squad-presets/:id/revert-to-template → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/squad-presets/guard-squad/revert-to-template', {
      method: 'POST',
      body: {},
    })
    expect(res.status).toBe(403)
  })

  // POST /:id/revert-template-fields — squad-presets:update
  test('POST /api/squad-presets/:id/revert-template-fields → 401 without identity', async () => {
    const res = await gfetch(null, '/api/squad-presets/guard-squad/revert-template-fields', {
      method: 'POST',
      body: { fields: [] },
    })
    expect(res.status).toBe(401)
  })
  test('POST /api/squad-presets/:id/revert-template-fields → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/squad-presets/guard-squad/revert-template-fields', {
      method: 'POST',
      body: { fields: [] },
    })
    expect(res.status).toBe(403)
  })

  // POST /:id/disable — squad-presets:update
  test('POST /api/squad-presets/:id/disable → 401 without identity', async () => {
    const res = await gfetch(null, '/api/squad-presets/guard-squad/disable', { method: 'POST', body: {} })
    expect(res.status).toBe(401)
  })
  test('POST /api/squad-presets/:id/disable → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/squad-presets/guard-squad/disable', { method: 'POST', body: {} })
    expect(res.status).toBe(403)
  })

  // POST /:id/enable — squad-presets:update
  test('POST /api/squad-presets/:id/enable → 401 without identity', async () => {
    const res = await gfetch(null, '/api/squad-presets/guard-squad/enable', { method: 'POST', body: {} })
    expect(res.status).toBe(401)
  })
  test('POST /api/squad-presets/:id/enable → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/squad-presets/guard-squad/enable', { method: 'POST', body: {} })
    expect(res.status).toBe(403)
  })

  // GET /:id/export — squad-presets:read
  test('GET /api/squad-presets/:id/export → 401 without identity', async () => {
    const res = await gfetch(null, '/api/squad-presets/guard-squad/export')
    expect(res.status).toBe(401)
  })
  test('GET /api/squad-presets/:id/export → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/squad-presets/guard-squad/export')
    expect(res.status).toBe(403)
  })
  test('GET /api/squad-presets/:id/export → 200 for admin', async () => {
    const res = await gfetch(admin.token, '/api/squad-presets/guard-squad/export')
    expect(res.status).toBe(200)
  })
})
