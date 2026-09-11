import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, agents, squads, amtpAllowRules } from '../db'
import { Agent } from '../entities/Agent'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { amtpRouter } from './amtp'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'

const app = new Hono()
app.use('/api/*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/amtp', amtpRouter)

const prefix = `fed-rules-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const PEER = 'peerinstrulesaaaaaaaaaaaaaaaaaaaa'
let admin: TestUser
let plainUser: TestUser
let squadId: string
const createdAgentIds: string[] = []

beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  plainUser = await createTestUser({ prefix })
  const [squad] = await db
    .insert(squads)
    .values({ name: `${prefix}-squad`, purpose: 'test' })
    .returning()
  squadId = squad.id
})

afterAll(async () => {
  await db.delete(squads).where(eq(squads.id, squadId))
  await cleanupTestRbac(prefix)
})

afterEach(async () => {
  for (const id of createdAgentIds.splice(0)) {
    await db.delete(amtpAllowRules).where(eq(amtpAllowRules.targetAgentId, id))
    await db.delete(agents).where(eq(agents.id, id))
  }
})

async function makeAgent() {
  const agent = await Agent.create({ agentTypeId: 'system-manager', squadId, context: {} })
  createdAgentIds.push(agent.id)
  return agent
}

describe('agent allow-rule routes', () => {
  test('operator creates, lists, and deletes a handle allow-rule', async () => {
    const agent = await makeAgent()
    const created = await app.request(`/api/amtp/agents/${agent.id}/allow-rules`, {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerInstanceId: PEER, principalKind: 'handle', principalValue: 'alice' }),
    })
    expect(created.status).toBe(201)
    const rule = await created.json()
    expect(rule).toMatchObject({ peerInstanceId: PEER, principalKind: 'handle', principalValue: 'alice' })

    const list = await app.request(`/api/amtp/agents/${agent.id}/allow-rules`, {
      headers: authHeaders(admin.token),
    })
    // GET returns a BARE array (not { allowRules }).
    expect(((await list.json()) as any[]).map((r: any) => r.id)).toEqual([rule.id])

    const del = await app.request(`/api/amtp/agents/${agent.id}/allow-rules/${rule.id}`, {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(del.status).toBe(200)
    const after = await app.request(`/api/amtp/agents/${agent.id}/allow-rules`, {
      headers: authHeaders(admin.token),
    })
    expect(await after.json()).toEqual([])
  })

  test("'handle' kind without principalValue is rejected 400", async () => {
    const agent = await makeAgent()
    const res = await app.request(`/api/amtp/agents/${agent.id}/allow-rules`, {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerInstanceId: PEER, principalKind: 'handle' }),
    })
    expect(res.status).toBe(400)
  })

  test('DELETE via a different agent path returns 404 and leaves original rule intact', async () => {
    const agentA = await makeAgent()
    const agentB = await makeAgent()
    // Create a rule belonging to agentA.
    const created = await app.request(`/api/amtp/agents/${agentA.id}/allow-rules`, {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerInstanceId: PEER, principalKind: 'any' }),
    })
    expect(created.status).toBe(201)
    const rule = await created.json()

    // Attempt to delete agentA's rule via agentB's path.
    const del = await app.request(`/api/amtp/agents/${agentB.id}/allow-rules/${rule.id}`, {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(del.status).toBe(404)

    // agentA's rule must still exist.
    const list = await app.request(`/api/amtp/agents/${agentA.id}/allow-rules`, {
      headers: authHeaders(admin.token),
    })
    const rules = (await list.json()) as any[]
    expect(rules.map((r: any) => r.id)).toContain(rule.id)
  })

  test('write without amtp:write is forbidden', async () => {
    const agent = await makeAgent()
    const res = await app.request(`/api/amtp/agents/${agent.id}/allow-rules`, {
      method: 'POST',
      headers: { ...authHeaders(plainUser.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerInstanceId: PEER, principalKind: 'any' }),
    })
    expect(res.status).toBe(403)
  })
})
