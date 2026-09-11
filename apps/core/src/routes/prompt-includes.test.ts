import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, promptIncludes, agentTypes } from '../db'
import { PromptInclude } from '../entities/PromptInclude'
import { AgentType } from '../entities/AgentType'
import { promptIncludesRoutes } from './prompt-includes'
import { promptIncludeSync } from '../services/config-sync'
import { identityMiddleware } from '../middleware/identity'
import { createTestAdmin, createTestUser, authHeaders, cleanupTestRbac, type TestUser } from '../test-utils'

// ── Apps ──────────────────────────────────────────────────────────────────────

/**
 * Functional test app: real identityMiddleware + promptIncludesRoutes.
 * All functional tests authenticate as admin.
 */
const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/prompt-includes', promptIncludesRoutes)

/**
 * Guard test app: same setup, used for RBAC denial tests.
 */
const guardApp = new Hono()
guardApp.use('*', identityMiddleware)
guardApp.route('/api/prompt-includes', promptIncludesRoutes)

// ── Shared RBAC state ─────────────────────────────────────────────────────────

const funcPrefix = `prompt-includes-func-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const guardPrefix = `prompt-includes-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let funcAdmin: TestUser
let unprivileged: TestUser

beforeAll(async () => {
  funcAdmin = await createTestAdmin({ prefix: funcPrefix })
  await createTestAdmin({ prefix: guardPrefix, canonicalAdmin: true })
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

describe('prompt include routes', () => {
  beforeEach(async () => {
    await db.delete(promptIncludes).where(eq(promptIncludes.id, 'custom-inc'))
    PromptInclude.invalidateCache()
  })

  test('creates, updates, disables, enables and deletes a custom include', async () => {
    let res = await app.request(
      '/api/prompt-includes',
      adminJson('POST', { id: 'custom-inc', name: 'Custom', content: 'Be terse.' })
    )
    expect(res.status).toBe(201)
    res = await app.request(
      '/api/prompt-includes/custom-inc',
      adminJson('PUT', { name: 'Custom', content: 'Be very terse.' })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).content).toBe('Be very terse.')
    res = await app.request('/api/prompt-includes/custom-inc/disable', adminReq('POST'))
    expect(res.status).toBe(200)
    expect((await (await app.request('/api/prompt-includes/custom-inc', adminReq('GET'))).json()).disabled).toBe(true)
    res = await app.request('/api/prompt-includes/custom-inc/enable', adminReq('POST'))
    expect(res.status).toBe(200)
    res = await app.request('/api/prompt-includes/custom-inc', adminReq('DELETE'))
    expect(res.status).toBe(200)
  })

  test('refuses to delete an include an agent type still references', async () => {
    await app.request('/api/prompt-includes', adminJson('POST', { id: 'custom-inc', name: 'Custom', content: 'x' }))
    await AgentType.upsert({ id: 'inc-user', name: 'Inc user', systemPrompt: 'hi', includes: ['custom-inc'] })
    const res = await app.request('/api/prompt-includes/custom-inc', adminReq('DELETE'))
    expect(res.status).toBe(409)
    expect((await res.json()).referencedBy).toEqual(['inc-user'])
    await db.delete(agentTypes).where(eq(agentTypes.id, 'inc-user'))
    AgentType.invalidateCache()
  })

  test('template-diff and revert work for a bundled include', async () => {
    await promptIncludeSync.sync()
    // The bundled `rules` include's template name comes from its markdown heading
    // ("## Operational Rules"), not the id — keep this equal to the template so
    // only `content` drifts, which is what this test is asserting.
    let res = await app.request(
      '/api/prompt-includes/rules',
      adminJson('PUT', { name: 'Operational Rules', content: 'edited' })
    )
    expect(res.status).toBe(200)
    const diff = await (await app.request('/api/prompt-includes/rules/template-diff', adminReq('GET'))).json()
    expect(diff.hasDrift).toBe(true)
    expect(diff.fieldOverrides).toEqual(['content'])
    res = await app.request('/api/prompt-includes/rules/revert-to-template', adminReq('POST'))
    expect(res.status).toBe(200)
    expect(
      (await (await app.request('/api/prompt-includes/rules', adminReq('GET'))).json()).yamlFieldOverrides
    ).toEqual([])
  })

  test('PUT omitting name preserves the existing name; an explicit blank name is rejected', async () => {
    await promptIncludeSync.sync()
    // Content-only update: `name` is omitted entirely, so the existing (template)
    // name must survive untouched and only `content` should show as drift.
    let res = await app.request('/api/prompt-includes/rules', adminJson('PUT', { content: 'edited' }))
    expect(res.status).toBe(200)
    expect((await res.json()).name).toBe('Operational Rules')
    const diff = await (await app.request('/api/prompt-includes/rules/template-diff', adminReq('GET'))).json()
    expect(diff.fieldOverrides).toEqual(['content'])

    res = await app.request('/api/prompt-includes/rules', adminJson('PUT', { name: '   ', content: 'x' }))
    expect(res.status).toBe(400)

    await app.request('/api/prompt-includes/rules/revert-to-template', adminReq('POST'))
  })

  test('denies writes without agent-types:update', async () => {
    const res = await guardFetch(unprivileged.token, '/api/prompt-includes', {
      method: 'POST',
      body: JSON.stringify({ id: 'nope', name: 'n', content: 'c' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(403)
  })
})
