import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { executions, agents, agentTypes, messages as messagesTable } from '../db/schema'
import { AgentType } from '../entities/AgentType'
import { Agent } from './Agent'
import { Execution } from './Execution'
import { Image } from './Image'
import { eventEmitter } from '../lib/infra/event-emitter'
import { listen } from '../lib/infra/local-events'

describe('Execution entity', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let testAgent: Agent
  let testAgentId: string

  beforeEach(async () => {
    testPrefix = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })

    testAgent = await Agent.create({
      agentTypeId: testAgentTypeId,
    })
    testAgentId = testAgent.id
  })

  afterEach(async () => {
    // Clean up executions for the test agent (cascade would handle this, but be explicit)
    await db.delete(executions).where(eq(executions.agentId, testAgentId))
    // Delete agent, then agent type
    await db.delete(agents).where(eq(agents.id, testAgentId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  describe('Agent.queueExecution', () => {
    it('creates with queued status, correct agentId, and message', async () => {
      const execution = await testAgent.queueExecution({
        message: 'Hello agent',
      })

      expect(execution.id).toBeDefined()
      expect(execution.status).toBe('queued')
      expect(execution.agentId).toBe(testAgentId)
      expect(execution.message).toBe('Hello agent')
      expect(execution.imageIds).toBeNull()
      expect(execution.usage).toBeNull()
      expect(execution.startedAt).toBeInstanceOf(Date)
      expect(execution.endedAt).toBeNull()
    })

    it('emits execution.created event', async () => {
      const events: any[] = []
      const unsub = eventEmitter.on('execution.created', (data) => events.push(data))

      const execution = await testAgent.queueExecution({
        message: 'Test message',
      })

      expect(events.length).toBe(1)
      expect(events[0].executionId).toBe(execution.id)
      expect(events[0].status).toBe('queued')
      unsub()
    })

    it('throws when agent already has an active execution', async () => {
      const exec = await testAgent.queueExecution({})
      await expect(testAgent.queueExecution({ message: 'second' })).rejects.toThrow(/already has an active execution/)
      await exec.transitionTo({ kind: 'completed' })
      const second = await testAgent.queueExecution({ message: 'after first completed' })
      expect(second.id).toBeDefined()
    })
  })

  describe('Execution.start', () => {
    it('starts queued execution atomically (status becomes running, agent becomes active)', async () => {
      const execution = await testAgent.queueExecution({
        message: 'Start me',
      })

      const started = await execution.start()
      expect(started).toBe(true)
      expect(execution.status).toBe('running')

      // Verify execution persisted
      const fetched = await Execution.find(execution.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.status).toBe('running')

      // Verify agent is now active
      await testAgent.reload()
      expect(testAgent.status).toBe('active')
    })

    it('rejects already-started execution (returns false)', async () => {
      const execution = await testAgent.queueExecution({})

      // First start succeeds
      const first = await execution.start()
      expect(first).toBe(true)

      // Second start fails
      const second = await execution.start()
      expect(second).toBe(false)
    })

    it('emits execution.started event', async () => {
      const execution = await testAgent.queueExecution({})

      const events: any[] = []
      const unsub = eventEmitter.on('execution.started', (data) => events.push(data))

      await execution.start()

      expect(events.length).toBe(1)
      expect(events[0].executionId).toBe(execution.id)
      expect(events[0].status).toBe('running')
      unsub()
    })
  })

  describe('Execution.update', () => {
    it('updates status and emits specific event (execution.completed)', async () => {
      const execution = await testAgent.queueExecution({})

      // Claim it first so it's running
      await execution.start()

      const events: any[] = []
      const unsub = eventEmitter.on('execution.completed', (data) => events.push(data))

      await execution.update({
        status: 'completed',
        endedAt: new Date(),
      })

      expect(execution.status).toBe('completed')
      expect(execution.endedAt).toBeInstanceOf(Date)
      expect(events.length).toBe(1)
      expect(events[0].executionId).toBe(execution.id)
      expect(events[0].status).toBe('completed')
      unsub()
    })
  })

  describe('Execution.find / mustFind', () => {
    it('finds execution by ID', async () => {
      const execution = await testAgent.queueExecution({ message: 'test' })
      const found = await Execution.find(execution.id)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(execution.id)
    })

    it('returns null for non-existent ID', async () => {
      const found = await Execution.find('00000000-0000-0000-0000-000000000000')
      expect(found).toBeNull()
    })

    it('mustFind throws for non-existent ID', async () => {
      await expect(Execution.mustFind('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/)
    })
  })

  describe('Execution.list', () => {
    it('filters by agentId', async () => {
      // Create a second agent
      const agent2 = await Agent.create({ agentTypeId: testAgentTypeId })

      const exec1 = await testAgent.queueExecution({ message: 'exec 1' })
      await exec1.transitionTo({ kind: 'completed' })
      await testAgent.queueExecution({ message: 'exec 2' })
      await agent2.queueExecution({ message: 'exec 3' })

      const filtered = await Execution.list({ agentId: testAgentId })
      expect(filtered.length).toBe(2)
      expect(filtered.every((e) => e.agentId === testAgentId)).toBe(true)

      // Clean up second agent
      await db.delete(executions).where(eq(executions.agentId, agent2.id))
      await db.delete(agents).where(eq(agents.id, agent2.id))
    })

    it('filters by status', async () => {
      const exec1 = await testAgent.queueExecution({ message: 'exec 1' })
      await exec1.transitionTo({ kind: 'completed' })
      await testAgent.queueExecution({ message: 'exec 2' })

      const queued = await Execution.list({ agentId: testAgentId, status: 'queued' })
      expect(queued.length).toBe(1)
      expect(queued[0].message).toBe('exec 2')

      const completed = await Execution.list({ agentId: testAgentId, status: 'completed' })
      expect(completed.length).toBe(1)
      expect(completed[0].message).toBe('exec 1')
    })

    it('returns queued executions oldest first to avoid queue starvation', async () => {
      const agent2 = await Agent.create({ agentTypeId: testAgentTypeId })

      try {
        const exec1 = await testAgent.queueExecution({ message: 'first queued' })
        const exec2 = await agent2.queueExecution({ message: 'second queued' })

        const queued = await Execution.list({ status: 'queued' })
        const testExecutions = queued.filter((exec) => exec.id === exec1.id || exec.id === exec2.id)
        expect(testExecutions.map((exec) => exec.id)).toEqual([exec1.id, exec2.id])
      } finally {
        await db.delete(executions).where(eq(executions.agentId, agent2.id))
        await db.delete(agents).where(eq(agents.id, agent2.id))
      }
    })
  })

  describe('Agent.getActiveExecution', () => {
    it('returns active execution for agent', async () => {
      const execution = await testAgent.queueExecution({
        message: 'Active execution',
      })

      const active = await testAgent.getActiveExecution()
      expect(active).not.toBeNull()
      expect(active!.id).toBe(execution.id)
      expect(active!.status).toBe('queued')
    })

    it('preserves the one-active-execution invariant while waiting for sandbox recovery', async () => {
      const execution = await testAgent.queueExecution({ message: 'waiting turn' })
      await execution.update({ status: 'waiting-sandbox' })

      const active = await testAgent.getActiveExecution()
      expect(active?.id).toBe(execution.id)
      expect(active?.isActive).toBe(true)
      await expect(testAgent.queueExecution({ message: 'duplicate' })).rejects.toThrow(
        /already has an active execution/
      )
    })

    it('merges images into the same execution without waking a sandbox wait', async () => {
      const execution = await testAgent.queueExecution({ message: 'waiting turn' })
      await execution.update({ status: 'waiting-sandbox' })
      const image = await Image.create({
        content: { type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' },
        agentId: testAgent.id,
      })

      expect(await testAgent.sendMessage('with image', { imageIds: [image.id] })).toMatchObject({
        status: 'waiting-sandbox',
      })
      const reloaded = await Execution.mustFind(execution.id)
      expect(reloaded.status).toBe('waiting-sandbox')
      expect(reloaded.imageIds).not.toBeNull()
      expect(reloaded.imageIds!).toContain(image.id)
      // sendMessage's successful return proves the target-scoped image load completed
      // before the image ID was merged into the waiting execution.
      await Image.deleteMany([image.id])
    })

    it('returns null when no active execution (all completed)', async () => {
      const execution = await testAgent.queueExecution({})

      // Claim and complete it
      await execution.start()
      await execution.update({
        status: 'completed',
        endedAt: new Date(),
      })

      const active = await testAgent.getActiveExecution()
      expect(active).toBeNull()
    })
  })

  describe('Execution helpers', () => {
    it('isActive returns true for active statuses', async () => {
      const execution = await testAgent.queueExecution({})
      expect(execution.isActive).toBe(true)

      await execution.update({ status: 'waiting-sandbox' })
      expect(execution.isActive).toBe(true)

      await execution.update({ status: 'queued' })
      await execution.start()
      expect(execution.isActive).toBe(true)

      await execution.update({ status: 'stopping' })
      expect(execution.isActive).toBe(true)
    })

    it('isTerminal returns true for terminal statuses', async () => {
      const execution = await testAgent.queueExecution({})
      expect(execution.isTerminal).toBe(false)

      await execution.update({ status: 'completed', endedAt: new Date() })
      expect(execution.isTerminal).toBe(true)
    })

    it('toJson returns serializable object', async () => {
      const execution = await testAgent.queueExecution({ message: 'test' })
      const json = execution.toJson()

      expect(json.id).toBe(execution.id)
      expect(json.agentId).toBe(execution.agentId)
      expect(json.status).toBe('queued')
      expect(json.message).toBe('test')
    })

    it('toJson keeps the per-execution usage delta intact', async () => {
      // Counter-requirement to the agent-row strip: the delta is exactly what
      // an execution row is FOR (per-execution consumption summed by
      // WorkStream.getMetrics), so serialization must not drop it.
      const execution = await testAgent.queueExecution({ message: 'test' })
      await execution.update({
        usage: {
          stats: {
            userMessages: 1,
            assistantMessages: 1,
            totalMessages: 2,
            tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
            cost: 1.25,
          },
          context: null,
          delta: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.5 },
        } as any,
      })

      const json = execution.toJson()

      expect(json.usage!.delta!.tokens.total).toBe(10)
      expect(json.usage!.delta!.cost).toBeCloseTo(0.5, 6)
      expect(json.usage!.stats.tokens.total).toBe(100)
    })
  })

  describe('Agent relation', () => {
    it('queueExecution sets agent relation', async () => {
      const execution = await testAgent.queueExecution({ message: 'test' })
      expect(execution.hasAgent).toBe(true)
      expect(execution.agent.id).toBe(testAgent.id)
    })

    it('getActiveExecution sets agent relation', async () => {
      await testAgent.queueExecution({ message: 'test' })
      const active = await testAgent.getActiveExecution()
      expect(active).not.toBeNull()
      expect(active!.hasAgent).toBe(true)
      expect(active!.agent.id).toBe(testAgent.id)
    })

    it('throws when accessing agent without loading', async () => {
      const execution = await testAgent.queueExecution({ message: 'test' })
      // Create a new execution without the relation set
      const rawExec = await Execution.find(execution.id)
      expect(rawExec!.hasAgent).toBe(false)
      expect(() => rawExec!.agent).toThrow(/Agent relation not loaded/)
    })

    it('mustGetAgent loads agent if not set', async () => {
      const execution = await testAgent.queueExecution({ message: 'test' })
      // Create a new execution without the relation set
      const rawExec = await Execution.find(execution.id)
      expect(rawExec!.hasAgent).toBe(false)

      const agent = await rawExec!.mustGetAgent()
      expect(agent.id).toBe(testAgent.id)
      expect(rawExec!.hasAgent).toBe(true)
    })

    it('setAgent allows manual relation setting', async () => {
      const execution = await testAgent.queueExecution({ message: 'test' })
      const rawExec = await Execution.find(execution.id)
      expect(rawExec!.hasAgent).toBe(false)

      rawExec!.setAgent(testAgent)
      expect(rawExec!.hasAgent).toBe(true)
      expect(rawExec!.agent.id).toBe(testAgent.id)
    })
  })

  describe('Execution transition methods', () => {
    it('no longer exposes pause/resume transition helpers', () => {
      const proto = Execution.prototype as unknown as Record<string, unknown>
      expect(proto.pause).toBeUndefined()
      expect(proto.resume).toBeUndefined()
      expect(proto.markPaused).toBeUndefined()
      expect(proto.requestPause).toBeUndefined()
      expect(proto.requestPauseWithSignal).toBeUndefined()
    })

    it('requestStopWithSignal is idempotent for already-stopping executions', async () => {
      const execution = await testAgent.queueExecution({ message: 'test' })
      await execution.update({ status: 'stopping' })

      const received: string[] = []
      const unlisten = await listen('agent_control', (payload) => {
        received.push(payload)
      })

      try {
        const result = await execution.requestStopWithSignal()
        expect(result).toBe(true)

        await new Promise((r) => setTimeout(r, 300))

        expect(execution.status).toBe('stopping')
        expect(received.length).toBe(1)
        const parsed = JSON.parse(received[0])
        expect(parsed.action).toBe('stop')
        expect(parsed.agentId).toBe(testAgent.id)
      } finally {
        await unlisten()
      }
    })

    it('supersede marks execution as completed without updating agent', async () => {
      const execution = await testAgent.queueExecution({ message: 'test' })
      await execution.start()
      expect(testAgent.status).toBe('active')

      await execution.supersede()

      expect(execution.status).toBe('completed')
      expect(execution.endedAt).not.toBeNull()
      // Agent status unchanged by supersede
      await testAgent.reload()
      expect(testAgent.status).toBe('active')
    })

    it('fail routes to waiting-input when all providers are exhausted', async () => {
      const execution = await testAgent.queueExecution({ message: 'test' })
      // Simulate a ModelSelectionError where all candidates are exhausted.
      const errorMsg =
        'No usable model in priority list. Attempted:\n  - anthropic:claude-sonnet-4-5: provider exhausted (in cooldown)'

      await execution.fail(errorMsg)

      await testAgent.reload()
      expect(testAgent.status).toBe('waiting-input')
      expect(testAgent.questionData).toBeTruthy()
      const question = (testAgent.questionData as any).questions[0]
      expect(question.id).toBe('all_providers_exhausted')
      expect(question.question).toContain('All configured providers are currently exhausted')
      expect(question.options[0]).toEqual({ value: 'Continue', label: 'Continue' })
    })

    it('fail routes health-classified errors to waiting-input with a Continue action', async () => {
      const execution = await testAgent.queueExecution({ message: 'test' })

      await execution.fail('rate limit exceeded')

      await testAgent.reload()
      expect(testAgent.status).toBe('waiting-input')
      expect(testAgent.questionData).toBeTruthy()
      const question = (testAgent.questionData as any).questions[0]
      expect(question.id).toBe('rate_limit')
      expect(question.options[0]).toEqual({ value: 'Continue', label: 'Continue' })
    })

    it('fail routes to idle for generic errors', async () => {
      const execution = await testAgent.queueExecution({ message: 'test' })

      await execution.fail('Something went wrong')

      await testAgent.reload()
      expect(testAgent.status).toBe('idle')
      expect(testAgent.questionData).toBeNull()
    })
  })

  describe('abortToolWithSignal', () => {
    it('returns false when execution is not running', async () => {
      const execution = await testAgent.queueExecution({ message: 'test' })
      expect(execution.status).toBe('queued')

      const result = await execution.abortToolWithSignal()
      expect(result).toBe(false)
    })

    it('returns true and sends an agent_control signal when execution is running', async () => {
      const execution = await testAgent.queueExecution({ message: 'test' })
      await execution.start()
      expect(execution.status).toBe('running')

      // Listen for the control signal
      const received: string[] = []
      const unlisten = await listen('agent_control', (payload) => {
        received.push(payload)
      })

      try {
        const result = await execution.abortToolWithSignal()
        expect(result).toBe(true)

        // Wait for async notification delivery
        await new Promise((r) => setTimeout(r, 300))

        expect(received.length).toBe(1)
        const parsed = JSON.parse(received[0])
        expect(parsed.action).toBe('abort-tool')
        expect(parsed.agentId).toBe(testAgent.id)
      } finally {
        await unlisten()
      }
    })
  })
})

describe('Execution.requestStopWithSignal on queued preserves pending messages', () => {
  it('keeps pending=true human rows after stop and lets the next execution confirm them', async () => {
    const testAgentTypeId = `exec-stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })
    const testAgent = await Agent.create({ agentTypeId: testAgentTypeId })
    const testAgentId = testAgent.id

    try {
      const exec = await testAgent.queueExecution({ message: 'first' })
      expect(exec.status).toBe('queued')

      await testAgent.recordMessage({
        role: 'human',
        content: 'steer while queued',
        metadata: { deliveryMode: 'steer' },
        pending: true,
      })

      const beforeStop = await db.select().from(messagesTable).where(eq(messagesTable.agentId, testAgentId))
      expect(beforeStop.filter((m) => m.pending && m.role === 'human').length).toBe(2)

      const stopped = await exec.requestStopWithSignal()
      expect(stopped).toBe(true)
      await exec.reload()
      expect(exec.status).toBe('stopped')

      const afterStop = await db.select().from(messagesTable).where(eq(messagesTable.agentId, testAgentId))
      expect(afterStop.filter((m) => m.pending && m.role === 'human').length).toBe(2)

      await testAgent.reload()
      expect(testAgent.status).toBe('idle')

      const next = await testAgent.queueExecution({ message: 'follow-up message' })
      await next.start()
      const confirmed = await testAgent.confirmAllPendingMessages()
      expect(confirmed).toBe(3)

      const remaining = await db.select().from(messagesTable).where(eq(messagesTable.agentId, testAgentId))
      expect(remaining.filter((m) => m.pending).length).toBe(0)
    } finally {
      await db.delete(executions).where(eq(executions.agentId, testAgentId))
      await db.delete(agents).where(eq(agents.id, testAgentId))
      await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    }
  })
})
