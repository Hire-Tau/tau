import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { identityMiddleware } from './identity'
import { requirePermission, requireSquadPermission } from './require-permission'
import {
  createTestUser,
  createTestAdmin,
  createTestRole,
  createTestCredential,
  assignRole,
  createTestAgentToken,
  authHeaders,
  cleanupTestRbac,
} from '../test-utils'
import { db } from '../db'
import { sessions, agentTokens, agents, agentTypes, localDeployments, squads } from '../db/schema'
import { eq, inArray, like } from 'drizzle-orm'
import { AgentType } from '../entities/AgentType'
import { Agent } from '../entities/Agent'
import { resetSecretStore } from '../services/secrets'
import { createDeviceToken } from '../services/auth/device-tokens'
import { Squad } from '../entities/Squad'
import { createLocalDeployment } from '../services/deploy/local-deployment-service'

const PREFIX = 'identity-test'

async function cleanup() {
  // agentTypeId is varchar so LIKE works; agent cascade handles agentTokens
  await db.delete(agents).where(like(agents.agentTypeId, `${PREFIX}%`))
  await db.delete(agentTypes).where(like(agentTypes.id, `${PREFIX}%`))
  await db.delete(squads).where(like(squads.name, `${PREFIX}%`))
  await cleanupTestRbac(PREFIX)
}

function createTestApp() {
  const app = new Hono()
  app.use('*', identityMiddleware)
  app.get('/whoami', (c) => {
    const identity = c.get('identity')
    return c.json(identity)
  })
  app.get('/auth-context', (c) =>
    c.json({
      identity: c.get('identity'),
      authContext: c.get('authContext'),
    })
  )
  return app
}

beforeAll(cleanup)
afterAll(cleanup)

describe('identityMiddleware', () => {
  test('resolves compact hostname prefix before browser-token validation', async () => {
    const [row] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-compact-${crypto.randomUUID()}`, purpose: 'Compact app auth test' })
      .returning()
    const localDeployment = await createLocalDeployment(new Squad(row), { name: 'web', port: 5173, mode: 'attached' })
    const token = new URL(localDeployment.urlPathOrHost, 'http://tau.test').searchParams.get('_tau_token')!
    const prefix = localDeployment.id.slice(0, 13)
    const app = new Hono()
    app.use('*', identityMiddleware)
    app.get('/api/app/:id/*', (c) => c.json({ resolvedId: c.get('resolvedLocalDeploymentId') }))

    const wrong = await app.request(`/api/app/${prefix}/?_tau_token=wrong`)
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('x-tau-app-proxy')).toBe('error')

    const response = await app.request(`/api/app/${prefix}/?_tau_token=${encodeURIComponent(token)}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ resolvedId: localDeployment.id })
  })

  test('maps a real ambiguous local-deployment prefix to fresh-link guidance', async () => {
    const [row] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-ambiguous-${crypto.randomUUID()}`, purpose: 'Ambiguous app auth test' })
      .returning()
    const squad = new Squad(row)
    const compact = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
    const prefix = `${compact.slice(0, 8)}-${compact.slice(8)}`
    await db.insert(localDeployments).values([
      {
        id: `${prefix}-4aaa-8aaa-aaaaaaaaaaaa`,
        squadId: squad.id,
        sandboxId: squad.sandboxId,
        portScope: squad.sandboxId,
        name: 'ambiguous-a',
        port: 5201,
        targetHost: '127.0.0.1',
        browserAccessToken: 'token-a',
        mode: 'attached',
      },
      {
        id: `${prefix}-4bbb-8bbb-bbbbbbbbbbbb`,
        squadId: squad.id,
        sandboxId: squad.sandboxId,
        portScope: squad.sandboxId,
        name: 'ambiguous-b',
        port: 5202,
        targetHost: '127.0.0.1',
        browserAccessToken: 'token-b',
        mode: 'attached',
      },
    ])
    const app = new Hono()
    app.use('*', identityMiddleware)
    app.get('/api/app/:id/*', () => new Response('must not run'))

    const response = await app.request(`/api/app/${prefix}/?_tau_token=irrelevant`)

    expect(response.status).toBe(409)
    expect(response.headers.get('x-tau-app-proxy')).toBe('error')
    expect(await response.json()).toEqual({ error: 'This app link is no longer unique — get a fresh URL.' })

    const wildcard = await app.request('/api/app/_/?_tau_token=irrelevant')
    expect(wildcard.status).toBe(401)
    expect(await wildcard.json()).toEqual({ error: 'Authentication required' })
  })

  test('rejects requests without token', async () => {
    const app = createTestApp()
    const res = await app.request('/whoami')
    expect(res.status).toBe(401)
  })

  test('resolves user identity from session token', async () => {
    const user = await createTestAdmin({ prefix: PREFIX })
    const app = createTestApp()
    const res = await app.request('/whoami', { headers: authHeaders(user.token) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.type).toBe('user')
    expect(body.userId).toBe(user.id)
  })

  test('sets identity and device credential provenance together', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const device = await createDeviceToken({ userId: user.id, name: 'CLI', platform: 'cli' })
    const app = createTestApp()

    const res = await app.request('/auth-context', { headers: authHeaders(device.token) })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      identity: { type: 'user', userId: user.id },
      authContext: {
        identity: { type: 'user', userId: user.id },
        deviceTokenId: device.id,
      },
    })
  })

  test('rejects expired session tokens', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    // Manually expire the session
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, user.sessionId))

    const app = createTestApp()
    const res = await app.request('/whoami', { headers: authHeaders(user.token) })
    expect(res.status).toBe(401)
  })

  test('resolves agent identity from agent token', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-squad`, purpose: 'Test squad' })
      .returning()

    await AgentType.create({
      id: `${PREFIX}-agent-type`,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test',
      systemPrompt: 'Test',
    })
    const agent = await Agent.create({
      agentTypeId: `${PREFIX}-agent-type`,
      squadId: squad.id,
    })

    const agentToken = await createTestAgentToken({
      agentId: agent.id,
      squadId: squad.id,
    })

    const app = createTestApp()
    const res = await app.request('/whoami', { headers: authHeaders(agentToken.token) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.type).toBe('agent')
    expect(body.agentId).toBe(agent.id)
    expect(body.squadId).toBe(squad.id)

    // Cleanup
    await db.delete(agentTokens).where(eq(agentTokens.id, agentToken.id))
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, `${PREFIX}-agent-type`))
    await db.delete(squads).where(eq(squads.id, squad.id))
  })

  test('rejects revoked agent tokens', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-squad-rev`, purpose: 'Test squad' })
      .returning()

    await AgentType.create({
      id: `${PREFIX}-agent-type-rev`,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Rev',
      systemPrompt: 'Test',
    })
    const agent = await Agent.create({
      agentTypeId: `${PREFIX}-agent-type-rev`,
      squadId: squad.id,
    })

    const agentToken = await createTestAgentToken({
      agentId: agent.id,
      squadId: squad.id,
    })

    // Revoke the token
    await db.update(agentTokens).set({ revokedAt: new Date() }).where(eq(agentTokens.id, agentToken.id))

    const app = createTestApp()
    const res = await app.request('/whoami', { headers: authHeaders(agentToken.token) })
    expect(res.status).toBe(401)

    // Cleanup
    await db.delete(agentTokens).where(eq(agentTokens.id, agentToken.id))
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, `${PREFIX}-agent-type-rev`))
    await db.delete(squads).where(eq(squads.id, squad.id))
  })

  test('supports X-Auth-Token fallback header', async () => {
    const user = await createTestAdmin({ prefix: PREFIX })
    const app = createTestApp()
    const res = await app.request('/whoami', {
      headers: { 'X-Auth-Token': user.token },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.type).toBe('user')
    expect(body.userId).toBe(user.id)
  })

  test('rejects TAU_PASSWORD once an admin user has a passkey', async () => {
    const originalPassword = process.env.TAU_PASSWORD

    try {
      const testPassword = `test-password-${Date.now()}`
      process.env.TAU_PASSWORD = testPassword

      // Reset the secret store cache so it picks up the env var
      resetSecretStore()

      // Create an admin user WITH a passkey — the normal, fully-provisioned state.
      const admin = await createTestAdmin({ prefix: `${PREFIX}-pw`, canonicalAdmin: true })
      await createTestCredential({ userId: admin.id })

      const app = createTestApp()

      // TAU_PASSWORD should be rejected since an admin holds a passkey
      const res = await app.request('/whoami', {
        headers: authHeaders(testPassword),
      })
      expect(res.status).toBe(401)

      // But session token still works
      const res2 = await app.request('/whoami', {
        headers: authHeaders(admin.token),
      })
      expect(res2.status).toBe(200)
    } finally {
      // Restore original password
      if (originalPassword) {
        process.env.TAU_PASSWORD = originalPassword
      } else {
        delete process.env.TAU_PASSWORD
      }
      resetSecretStore()
      await cleanupTestRbac(`${PREFIX}-pw`)
    }
  })

  test('accepts TAU_PASSWORD in the restored state (admin rows exist, zero credentials)', async () => {
    const originalPassword = process.env.TAU_PASSWORD

    try {
      const testPassword = `test-password-restore-${Date.now()}`
      process.env.TAU_PASSWORD = testPassword
      resetSecretStore()

      // Cross-subdomain restore: admin user/role rows survive, but the
      // origin-bound passkey credentials were stripped (none created here).
      await createTestAdmin({ prefix: `${PREFIX}-restore`, canonicalAdmin: true })

      const app = createTestApp()

      // Password authenticates as the legacy bootstrap identity.
      const res = await app.request('/whoami', {
        headers: authHeaders(testPassword),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.type).toBe('legacy')
    } finally {
      if (originalPassword) {
        process.env.TAU_PASSWORD = originalPassword
      } else {
        delete process.env.TAU_PASSWORD
      }
      resetSecretStore()
      await cleanupTestRbac(`${PREFIX}-restore`)
    }
  })

  test('self-heals: password auth turns off the moment an admin registers a passkey', async () => {
    const originalPassword = process.env.TAU_PASSWORD

    try {
      const testPassword = `test-password-heal-${Date.now()}`
      process.env.TAU_PASSWORD = testPassword
      resetSecretStore()

      const admin = await createTestAdmin({ prefix: `${PREFIX}-heal`, canonicalAdmin: true })
      const app = createTestApp()

      // Restored state: password works.
      const before = await app.request('/whoami', { headers: authHeaders(testPassword) })
      expect(before.status).toBe(200)

      // Admin re-registers a passkey.
      await createTestCredential({ userId: admin.id })

      // Password auth is now off.
      const after = await app.request('/whoami', { headers: authHeaders(testPassword) })
      expect(after.status).toBe(401)
    } finally {
      if (originalPassword) {
        process.env.TAU_PASSWORD = originalPassword
      } else {
        delete process.env.TAU_PASSWORD
      }
      resetSecretStore()
      await cleanupTestRbac(`${PREFIX}-heal`)
    }
  })
})

describe('requirePermission', () => {
  test('allows when permission is granted', async () => {
    const admin = await createTestAdmin({ prefix: `${PREFIX}-rp` })
    const app = new Hono()
    app.use('*', identityMiddleware)
    app.get('/admin', requirePermission('agents:read'), (c) => c.json({ ok: true }))

    const res = await app.request('/admin', { headers: authHeaders(admin.token) })
    expect(res.status).toBe(200)

    await cleanupTestRbac(`${PREFIX}-rp`)
  })

  test('denies when permission is not granted', async () => {
    const user = await createTestUser({ prefix: `${PREFIX}-rp2` })
    // User has no roles/permissions
    const app = new Hono()
    app.use('*', identityMiddleware)
    app.get('/admin', requirePermission('agents:read'), (c) => c.json({ ok: true }))

    const res = await app.request('/admin', { headers: authHeaders(user.token) })
    expect(res.status).toBe(403)

    await cleanupTestRbac(`${PREFIX}-rp2`)
  })
})

describe('requireSquadPermission', () => {
  test('checks squad-scoped permission from :id param', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-squad-perm`, purpose: 'Test' })
      .returning()

    const user = await createTestUser({ prefix: `${PREFIX}-sp` })
    const role = await createTestRole({
      prefix: `${PREFIX}-sp`,
      permissions: ['agents:read'],
    })
    await assignRole({
      userId: user.id,
      roleId: role.id,
      scope: 'squad',
      squadId: squad.id,
    })

    const app = new Hono()
    app.use('*', identityMiddleware)
    app.get('/squads/:id/agents', requireSquadPermission('agents:read'), (c) => c.json({ ok: true }))

    // Should pass for the right squad
    const res = await app.request(`/squads/${squad.id}/agents`, {
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(200)

    // Should fail for a different squad. It has to be a REAL one: the guard resolves its route
    // param to a squad before authorizing, so an id that names nothing is a 404, not a verdict
    // about a squad the caller cannot have a role on.
    const [otherSquad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-squad-perm-other`, purpose: 'Test' })
      .returning()
    const res2 = await app.request(`/squads/${otherSquad.id}/agents`, {
      headers: authHeaders(user.token),
    })
    expect(res2.status).toBe(403)

    // A short id prefix authorizes the squad it resolves to, not the raw string: a squad-scoped
    // grant must survive the prefix form, and must not leak to another squad through it.
    const granted = await app.request(`/squads/${squad.id.slice(0, 8)}/agents`, {
      headers: authHeaders(user.token),
    })
    expect(granted.status).toBe(200)
    const denied = await app.request(`/squads/${otherSquad.id.slice(0, 8)}/agents`, {
      headers: authHeaders(user.token),
    })
    expect(denied.status).toBe(403)

    // An id that resolves to no squad is a 404.
    const missing = await app.request('/squads/00000000-0000-0000-0000-000000000000/agents', {
      headers: authHeaders(user.token),
    })
    expect(missing.status).toBe(404)

    // Cleanup
    await cleanupTestRbac(`${PREFIX}-sp`)
    await db.delete(squads).where(inArray(squads.id, [squad.id, otherSquad.id]))
  })
})
