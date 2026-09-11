import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, skills } from '../db'
import { Skill } from '../entities/Skill'
import { skillsRoutes } from './skills'
import { identityMiddleware } from '../middleware/identity'
import { createTestAdmin, createTestUser, authHeaders, cleanupTestRbac, type TestUser } from '../test-utils'

// ── Apps ──────────────────────────────────────────────────────────────────────

/**
 * Functional test app: real identityMiddleware + skillsRoutes.
 * All functional tests authenticate as admin.
 */
const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/skills', skillsRoutes)

/**
 * Guard test app: same setup, used for RBAC denial tests.
 */
const guardApp = new Hono()
guardApp.use('*', identityMiddleware)
guardApp.route('/api/skills', skillsRoutes)

// ── Shared RBAC state ─────────────────────────────────────────────────────────

const funcPrefix = `skills-func-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const guardPrefix = `skills-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let funcAdmin: TestUser
let guardAdmin: TestUser
let unprivileged: TestUser

beforeAll(async () => {
  funcAdmin = await createTestAdmin({ prefix: funcPrefix })
  guardAdmin = await createTestAdmin({ prefix: guardPrefix, canonicalAdmin: true })
  unprivileged = await createTestUser({ prefix: guardPrefix })
})

afterAll(async () => {
  await cleanupTestRbac(funcPrefix)
  await cleanupTestRbac(guardPrefix)
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function adminJson(method: string, body?: unknown) {
  const headers: Record<string, string> = {
    ...authHeaders(funcAdmin.token),
    'content-type': 'application/json',
  }
  return { method, body: body ? JSON.stringify(body) : undefined, headers }
}

function adminReq(method: string) {
  return { method, headers: authHeaders(funcAdmin.token) }
}

async function guardFetch(
  token: string | null,
  path: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> }
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (token) Object.assign(headers, authHeaders(token))
  if (init?.headers) Object.assign(headers, init.headers)
  return guardApp.fetch(
    new Request(`http://localhost${path}`, {
      method: init?.method ?? 'GET',
      body: init?.body,
      headers,
    })
  )
}

// ── Functional tests ──────────────────────────────────────────────────────────

describe('skills routes', () => {
  beforeEach(async () => {
    await db.delete(skills)
    Skill.invalidateCache()
  })

  test('creates, exports, disables, enables, and deletes a custom skill', async () => {
    let res = await app.request(
      '/api/skills',
      adminJson('POST', { id: 'custom-skill', name: 'Custom', content: '# Custom\n\nBody' })
    )
    expect(res.status).toBe(201)
    res = await app.request('/api/skills/custom-skill/export', adminReq('GET'))
    expect(await res.text()).toContain('# Custom')
    res = await app.request('/api/skills/custom-skill/disable', adminReq('POST'))
    expect(res.status).toBe(200)
    expect((await Skill.mustFind('custom-skill')).disabled).toBe(true)
    res = await app.request('/api/skills/custom-skill/enable', adminReq('POST'))
    expect(res.status).toBe(200)
    res = await app.request('/api/skills/custom-skill', adminReq('DELETE'))
    expect(res.status).toBe(200)
  })

  test('imports markdown and rejects duplicate IDs', async () => {
    const res = await app.request('/api/skills/import', adminJson('POST', { content: '# Imported Skill\n\nDesc' }))
    expect(res.status).toBe(201)
    expect((await res.json()).id).toBe('imported-skill')
    const dup = await app.request(
      '/api/skills/import',
      adminJson('POST', { id: 'imported-skill', content: '# Imported Skill\n' })
    )
    expect(dup.status).toBe(409)
  })

  test('rejects deleting template skills and returns 404 disabling missing skills', async () => {
    await db.insert(skills).values({
      id: 'default-skill',
      name: 'Default',
      content: '# Default',
      yamlTemplate: { id: 'default-skill', name: 'Default', description: null, content: '# Default' },
    })
    Skill.invalidateCache()
    let res = await app.request('/api/skills/default-skill', adminReq('DELETE'))
    expect(res.status).toBe(400)
    res = await app.request('/api/skills/missing/disable', adminReq('POST'))
    expect(res.status).toBe(404)
  })

  test('returns template diff and reverts admin edits', async () => {
    await db.insert(skills).values({
      id: 'default-skill',
      name: 'Changed',
      content: '# Changed',
      yamlTemplate: { id: 'default-skill', name: 'Default', description: null, content: '# Default' },
      yamlFieldOverrides: ['name', 'content'],
    })
    Skill.invalidateCache()
    let res = await app.request('/api/skills/default-skill/template-diff', adminReq('GET'))
    expect(res.status).toBe(200)
    expect((await res.json()).hasDrift).toBe(true)
    res = await app.request('/api/skills/default-skill/revert-to-template', adminReq('POST'))
    expect(res.status).toBe(200)
    const [row] = await db.select().from(skills).where(eq(skills.id, 'default-skill'))
    expect(row.name).toBe('Default')
    expect(row.yamlFieldOverrides).toEqual([])
  })

  test('adds, updates, and removes individual support files', async () => {
    await Skill.upsert({ id: 'custom-skill', name: 'Custom', content: '# Custom', supportFiles: { 'keep.md': 'keep' } })

    let res = await app.request(
      '/api/skills/custom-skill/support-file',
      adminJson('PUT', { path: 'helper.md', content: 'one' })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).supportFiles).toEqual({ 'keep.md': 'keep', 'helper.md': 'one' })

    res = await app.request(
      '/api/skills/custom-skill/support-file',
      adminJson('PUT', { path: 'helper.md', content: 'two' })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).supportFiles['helper.md']).toBe('two')

    res = await app.request('/api/skills/custom-skill/support-file', adminJson('DELETE', { path: 'helper.md' }))
    expect(res.status).toBe(200)
    expect((await res.json()).supportFiles).toEqual({ 'keep.md': 'keep' })
  })

  test('rejects support file path traversal', async () => {
    const res = await app.request(
      '/api/skills',
      adminJson('POST', { id: 'bad-skill', name: 'Bad', content: '# Bad', supportFiles: { '../evil.md': 'nope' } })
    )
    expect(res.status).toBe(400)
  })
})

// ── RBAC guard tests ──────────────────────────────────────────────────────────

describe('skills RBAC guards', () => {
  const jsonHeaders = { 'Content-Type': 'application/json' }

  beforeEach(async () => {
    await db.delete(skills)
    Skill.invalidateCache()
  })

  // GET / (skills:read)
  test('GET /api/skills → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/skills')
    expect(res.status).toBe(401)
  })

  test('GET /api/skills → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/skills')
    expect(res.status).toBe(403)
  })

  test('GET /api/skills → 200 for admin', async () => {
    const res = await guardFetch(guardAdmin.token, '/api/skills')
    expect(res.status).toBe(200)
  })

  // GET /:id (skills:read)
  test('GET /api/skills/:id → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/skills/some-skill')
    expect(res.status).toBe(401)
  })

  test('GET /api/skills/:id → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/skills/some-skill')
    expect(res.status).toBe(403)
  })

  // POST / (skills:write)
  test('POST /api/skills → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/skills', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ id: 'new-skill', name: 'New', content: '# New' }),
    })
    expect(res.status).toBe(401)
  })

  test('POST /api/skills → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/skills', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ id: 'new-skill', name: 'New', content: '# New' }),
    })
    expect(res.status).toBe(403)
  })

  test('POST /api/skills → 201 for admin', async () => {
    const res = await guardFetch(guardAdmin.token, '/api/skills', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ id: 'new-skill', name: 'New', content: '# New' }),
    })
    expect(res.status).toBe(201)
  })

  // POST /import (skills:write)
  test('POST /api/skills/import → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/skills/import', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ content: '# Guard Import\n\nBody' }),
    })
    expect(res.status).toBe(401)
  })

  test('POST /api/skills/import → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/skills/import', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ content: '# Guard Import\n\nBody' }),
    })
    expect(res.status).toBe(403)
  })

  // PUT /:id (skills:write)
  test('PUT /api/skills/:id → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/skills/some-skill', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ name: 'Updated', content: '# Updated' }),
    })
    expect(res.status).toBe(401)
  })

  test('PUT /api/skills/:id → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/skills/some-skill', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ name: 'Updated', content: '# Updated' }),
    })
    expect(res.status).toBe(403)
  })

  // DELETE /:id (skills:write)
  test('DELETE /api/skills/:id → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/skills/some-skill', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  test('DELETE /api/skills/:id → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/skills/some-skill', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  // GET /:id/template-diff (skills:read)
  test('GET /api/skills/:id/template-diff → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/skills/some-skill/template-diff')
    expect(res.status).toBe(401)
  })

  test('GET /api/skills/:id/template-diff → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/skills/some-skill/template-diff')
    expect(res.status).toBe(403)
  })

  // POST /:id/revert-to-template (skills:write)
  test('POST /api/skills/:id/revert-to-template → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/skills/some-skill/revert-to-template', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  test('POST /api/skills/:id/revert-to-template → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/skills/some-skill/revert-to-template', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  // POST /:id/revert-template-fields (skills:write)
  test('POST /api/skills/:id/revert-template-fields → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/skills/some-skill/revert-template-fields', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ fields: [] }),
    })
    expect(res.status).toBe(401)
  })

  test('POST /api/skills/:id/revert-template-fields → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/skills/some-skill/revert-template-fields', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ fields: [] }),
    })
    expect(res.status).toBe(403)
  })

  // POST /:id/disable (skills:write)
  test('POST /api/skills/:id/disable → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/skills/some-skill/disable', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  test('POST /api/skills/:id/disable → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/skills/some-skill/disable', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  // POST /:id/enable (skills:write)
  test('POST /api/skills/:id/enable → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/skills/some-skill/enable', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  test('POST /api/skills/:id/enable → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/skills/some-skill/enable', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  // PUT /:id/support-file (skills:write)
  test('PUT /api/skills/:id/support-file → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/skills/some-skill/support-file', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ path: 'helper.md', content: 'hi' }),
    })
    expect(res.status).toBe(401)
  })

  test('PUT /api/skills/:id/support-file → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/skills/some-skill/support-file', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ path: 'helper.md', content: 'hi' }),
    })
    expect(res.status).toBe(403)
  })

  // DELETE /:id/support-file (skills:write)
  test('DELETE /api/skills/:id/support-file → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/skills/some-skill/support-file', {
      method: 'DELETE',
      headers: jsonHeaders,
      body: JSON.stringify({ path: 'helper.md' }),
    })
    expect(res.status).toBe(401)
  })

  test('DELETE /api/skills/:id/support-file → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/skills/some-skill/support-file', {
      method: 'DELETE',
      headers: jsonHeaders,
      body: JSON.stringify({ path: 'helper.md' }),
    })
    expect(res.status).toBe(403)
  })

  // GET /:id/export (skills:read)
  test('GET /api/skills/:id/export → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/skills/some-skill/export')
    expect(res.status).toBe(401)
  })

  test('GET /api/skills/:id/export → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/skills/some-skill/export')
    expect(res.status).toBe(403)
  })
})
