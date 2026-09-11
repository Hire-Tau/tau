import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { agentsRouter } from './agents'
import { AgentType } from '../entities/AgentType'
import { Squad } from '../entities/Squad'
import { db, agents, agentTypes, squads } from '../db'
import { Agent } from '../entities/Agent'
import { ensureSquadMemoryPath } from '../services/memory/paths'
import { identityMiddleware } from '../middleware/identity'
import { createTestAdmin, authHeaders, cleanupTestRbac, type TestUser } from '../test-utils'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/agents', agentsRouter)

// ── Shared RBAC setup ────────────────────────────────────────────────────────

const rbacPrefix = `actx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: rbacPrefix })
})

afterAll(async () => {
  await cleanupTestRbac(rbacPrefix)
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('agent context route', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let testSquad: Squad
  let testAgent: Agent
  let testAgentId: string
  let workspacePath: string

  beforeEach(async () => {
    testPrefix = `acr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-agent-type`

    // Create agent type
    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent',
      systemPrompt: 'Test',
    })

    // Create squad (no typeId needed)
    testSquad = await Squad.create({
      name: 'Test Squad',
      purpose: 'Testing context endpoint',
    })

    // Create agent in squad
    testAgent = await Agent.create({
      agentTypeId: testAgentTypeId,
      squadId: testSquad.id,
    })
    testAgentId = testAgent.id

    // Get squad memory path for todo storage (matches createSquadTodoTools/route handler storage).
    workspacePath = ensureSquadMemoryPath(testSquad.id)
  })

  afterEach(async () => {
    // Clean up workspace
    try {
      rmSync(workspacePath, { recursive: true, force: true })
    } catch {
      // Ignore if doesn't exist
    }

    // Clean up database
    await db.delete(agents).where(eq(agents.id, testAgentId))
    await db.delete(squads).where(eq(squads.id, testSquad.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  describe('GET /api/agents/:id/context', () => {
    it('returns empty context for new agent', async () => {
      const res = await app.request(`/api/agents/${testAgentId}/context`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)

      const result = await res.json()
      expect(result.shortTermMemory).toBe('')
      expect(result.todos).toEqual([])
    })

    it('returns 404 for non-existent agent (admin passes system-scope check, handler returns 404)', async () => {
      const res = await app.request('/api/agents/00000000-0000-0000-0000-000000000000/context', {
        headers: authHeaders(admin.token),
      })
      // Null squadId (agent not found) → system-scope check → admin passes → handler returns 404
      expect(res.status).toBe(404)
    })

    it('returns short-term memory from agent context', async () => {
      // Update agent with short-term memory
      await testAgent.update({
        context: { shortTermMemory: 'Remember to check the logs' },
      })

      const res = await app.request(`/api/agents/${testAgentId}/context`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)

      const result = await res.json()
      expect(result.shortTermMemory).toBe('Remember to check the logs')
    })

    it('returns todos from workspace file', async () => {
      // Create todos file in workspace
      const todosDir = join(workspacePath, '.todos')
      mkdirSync(todosDir, { recursive: true })

      const todoContent = `- [ ] First task
- [x] Completed task
- [ ] Third task (depends: 1)`

      writeFileSync(join(todosDir, `${testAgentId}.md`), todoContent)

      const res = await app.request(`/api/agents/${testAgentId}/context`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)

      const result = await res.json()
      expect(result.todos).toHaveLength(3)
      expect(result.todos[0]).toEqual({ text: 'First task', completed: false, depends: [] })
      expect(result.todos[1]).toEqual({ text: 'Completed task', completed: true, depends: [] })
      expect(result.todos[2]).toEqual({ text: 'Third task', completed: false, depends: [1] })
    })

    it('returns both short-term memory and todos', async () => {
      // Set up short-term memory
      await testAgent.update({
        context: { shortTermMemory: 'Working on feature X' },
      })

      // Set up todos
      const todosDir = join(workspacePath, '.todos')
      mkdirSync(todosDir, { recursive: true })
      writeFileSync(join(todosDir, `${testAgentId}.md`), '- [ ] Implement feature X\n- [ ] Write tests')

      const res = await app.request(`/api/agents/${testAgentId}/context`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)

      const result = await res.json()
      expect(result.shortTermMemory).toBe('Working on feature X')
      expect(result.todos).toHaveLength(2)
    })

    it('returns 200 for squad-less agent for admin (system-scope check allows)', async () => {
      // Squad-less agents have null squadId; requireEntityPermission now falls back to system-scope check.
      // An admin with * passes; handler returns 200 with empty context.
      const standaloneAgent = await Agent.create({ agentTypeId: testAgentTypeId })

      try {
        const res = await app.request(`/api/agents/${standaloneAgent.id}/context`, {
          headers: authHeaders(admin.token),
        })
        expect(res.status).toBe(200)
        const result = await res.json()
        expect(result.shortTermMemory).toBe('')
        expect(result.todos).toEqual([])
      } finally {
        await db.delete(agents).where(eq(agents.id, standaloneAgent.id))
      }
    })

    it('returns 401 without auth token', async () => {
      const res = await app.request(`/api/agents/${testAgentId}/context`)
      expect(res.status).toBe(401)
    })
  })
})
