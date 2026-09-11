import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db'
import { agents, agentTypes, executions, squads } from '../db/schema'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware/identity'
import { subscribeToSquad } from '../services/squad/subscriptions'
import { setResumeHaltedBeforeAuthoritativeLockHookForTests } from '../services/agents/resume'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../test-utils'
import { agentsRouter } from './agents'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/agents', agentsRouter)

const prefix = `continue-halted-${crypto.randomUUID()}`
let visibleSquad: Squad
let hiddenSquad: Squad
let user: TestUser
let submitted: Agent
let unsubmitted: Agent
let hidden: Agent

async function halt(agent: Agent): Promise<void> {
  await db
    .update(agents)
    .set({
      status: 'waiting-input',
      questionData: { questions: [{ id: 'rate_limit', type: 'text', question: 'Provider unavailable' }] },
    })
    .where(eq(agents.id, agent.id))
}

async function post(body?: unknown): Promise<Response> {
  return app.request('/api/agents/continue-halted', {
    method: 'POST',
    headers: { ...authHeaders(user.token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeAll(async () => {
  await AgentType.create({ id: `${prefix}-type`, name: 'Continue halted', model: 'test:model', systemPrompt: 'test' })
  visibleSquad = await Squad.create({ name: `${prefix}-visible`, purpose: 'watched squad' })
  hiddenSquad = await Squad.create({ name: `${prefix}-hidden`, purpose: 'unwatched squad' })
  user = await createTestUser({ prefix: `${prefix}-user` })
  const role = await createTestRole({ prefix: `${prefix}-role`, permissions: ['actions:read', 'agents:run'] })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: visibleSquad.id })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: hiddenSquad.id })
  await subscribeToSquad(visibleSquad.id, user.id)
  submitted = await Agent.create({ agentTypeId: `${prefix}-type`, squadId: visibleSquad.id })
  unsubmitted = await Agent.create({ agentTypeId: `${prefix}-type`, squadId: visibleSquad.id })
  hidden = await Agent.create({ agentTypeId: `${prefix}-type`, squadId: hiddenSquad.id })
  await Promise.all([halt(submitted), halt(unsubmitted), halt(hidden)])
})

afterAll(async () => {
  setResumeHaltedBeforeAuthoritativeLockHookForTests(undefined)
  await db.delete(agents).where(inArray(agents.id, [submitted.id, unsubmitted.id, hidden.id]))
  await db.delete(squads).where(inArray(squads.id, [visibleSquad.id, hiddenSquad.id]))
  await db.delete(agentTypes).where(eq(agentTypes.id, `${prefix}-type`))
  await cleanupTestRbac(prefix)
})

describe('POST /api/agents/continue-halted', () => {
  test('bodyful requests resume only exact submitted currently visible action IDs', async () => {
    const actionId = `agent-error:${submitted.id}`
    const response = await post({ actionIds: [actionId, actionId] })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ resumed: 1, resumedActionIds: [actionId], staleActionIds: [] })
    expect((await Agent.mustFind(submitted.id)).questionData).toBeNull()
    expect((await Agent.mustFind(unsubmitted.id)).questionData).not.toBeNull()
    expect((await Agent.mustFind(hidden.id)).questionData).not.toBeNull()
  })

  test('rejects stale or hidden submitted IDs without resuming other visible actions', async () => {
    await halt(submitted)
    const hiddenActionId = `agent-error:${hidden.id}`
    const response = await post({ actionIds: [hiddenActionId] })

    expect(response.status).toBe(404)
    expect((await response.json()).code).toBe('action_not_found')
    expect((await Agent.mustFind(submitted.id)).questionData).not.toBeNull()
    expect((await Agent.mustFind(hidden.id)).questionData).not.toBeNull()
  })

  test('revalidates current scope and rejects reassignment after the visible snapshot', async () => {
    await halt(submitted)
    setResumeHaltedBeforeAuthoritativeLockHookForTests(async (agentId) => {
      if (agentId !== submitted.id) return
      setResumeHaltedBeforeAuthoritativeLockHookForTests(undefined)
      await db.update(agents).set({ squadId: null, ownerUserId: null }).where(eq(agents.id, agentId))
    })
    const response = await post({ actionIds: [`agent-error:${submitted.id}`] })

    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('action_forbidden')
    expect((await Agent.mustFind(submitted.id)).questionData).not.toBeNull()
    await db.update(agents).set({ squadId: visibleSquad.id }).where(eq(agents.id, submitted.id))
  })

  test('reports termination-raced submitted IDs as stale without creating an execution', async () => {
    await halt(submitted)
    const before = await db.select().from(executions).where(eq(executions.agentId, submitted.id))
    setResumeHaltedBeforeAuthoritativeLockHookForTests(async (agentId) => {
      if (agentId !== submitted.id) return
      setResumeHaltedBeforeAuthoritativeLockHookForTests(undefined)
      await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, agentId))
    })
    const actionId = `agent-error:${submitted.id}`
    const response = await post({ actionIds: [actionId] })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ resumed: 0, resumedActionIds: [], staleActionIds: [actionId] })
    expect(await db.select().from(executions).where(eq(executions.agentId, submitted.id))).toHaveLength(before.length)
    await db.update(agents).set({ terminatedAt: null }).where(eq(agents.id, submitted.id))
  })

  test('single-agent continuation revalidates reassigned scope under the authoritative lock', async () => {
    await halt(submitted)
    const before = await db.select().from(executions).where(eq(executions.agentId, submitted.id))
    setResumeHaltedBeforeAuthoritativeLockHookForTests(async (agentId) => {
      if (agentId !== submitted.id) return
      setResumeHaltedBeforeAuthoritativeLockHookForTests(undefined)
      await db.update(agents).set({ squadId: null, ownerUserId: null }).where(eq(agents.id, agentId))
    })

    const response = await app.request(`/api/agents/${submitted.id}/continue`, {
      method: 'POST',
      headers: authHeaders(user.token),
    })
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('action_forbidden')
    expect(await db.select().from(executions).where(eq(executions.agentId, submitted.id))).toHaveLength(before.length)
    expect((await Agent.mustFind(submitted.id)).questionData).not.toBeNull()
    await db.update(agents).set({ squadId: visibleSquad.id }).where(eq(agents.id, submitted.id))
  })

  test('keeps the bodyless CLI path explicitly global across authorized squads', async () => {
    await db
      .update(agents)
      .set({ status: 'idle', questionData: null })
      .where(inArray(agents.id, [submitted.id, unsubmitted.id, hidden.id]))
    const bodylessVisible = await Agent.create({ agentTypeId: `${prefix}-type`, squadId: visibleSquad.id })
    const bodylessHidden = await Agent.create({ agentTypeId: `${prefix}-type`, squadId: hiddenSquad.id })
    try {
      await Promise.all([halt(bodylessVisible), halt(bodylessHidden)])
      const response = await post()

      expect(response.status).toBe(200)
      expect((await response.json()).resumed).toBe(2)
    } finally {
      await db.delete(agents).where(inArray(agents.id, [bodylessVisible.id, bodylessHidden.id]))
    }
  })
})
