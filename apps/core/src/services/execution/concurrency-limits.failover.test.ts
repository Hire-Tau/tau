import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db } from '../../db'
import { agents, agentTypes, executions, messages } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import * as modelSelection from '../model-selection'
import { providerHealth, resetProviderHealthForTests } from '../provider-health/registry'
import { MockAgentSession, TestAgentRunner, makeAgentType } from './test-helpers'
import { removeSession } from './session-state'
import { concurrencyLimiter } from './concurrency-limiter-instance'

describe('provider concurrency runtime reconciliation/failover', () => {
  const createdAgentIds: string[] = []
  const createdAgentTypeIds: string[] = []
  const createdExecutionIds: string[] = []
  let originalAnthropicLimit: number | undefined
  let selectModelSpy: ReturnType<typeof spyOn> | undefined
  let reassignSpy: ReturnType<typeof spyOn> | undefined
  const pendingAgentWrites = new Set<Promise<unknown>>()
  let agentWriteCompletionHook: (() => Promise<void>) | undefined

  beforeEach(() => {
    concurrencyLimiter.reset()
    resetProviderHealthForTests()
    originalAnthropicLimit = (concurrencyLimiter as any).limits['anthropic/claude-sonnet-4-5']
    ;(concurrencyLimiter as any).limits['anthropic/claude-sonnet-4-5'] = 10
  })

  afterEach(async () => {
    selectModelSpy?.mockRestore()
    selectModelSpy = undefined
    reassignSpy?.mockRestore()
    reassignSpy = undefined
    resetProviderHealthForTests()
    await mustComplete(drainAgentWrites(), 'failover-triggered agent writes did not drain')
    agentWriteCompletionHook = undefined
    if (originalAnthropicLimit === undefined) delete (concurrencyLimiter as any).limits['anthropic/claude-sonnet-4-5']
    else (concurrencyLimiter as any).limits['anthropic/claude-sonnet-4-5'] = originalAnthropicLimit

    for (const executionId of createdExecutionIds.splice(0)) {
      concurrencyLimiter.release(executionId)
    }
    concurrencyLimiter.reset()
    for (const agentId of createdAgentIds.splice(0)) {
      removeSession(agentId)
      await db
        .delete(messages)
        .where(eq(messages.agentId, agentId))
        .catch(() => {})
      await db
        .delete(executions)
        .where(eq(executions.agentId, agentId))
        .catch(() => {})
      await db
        .delete(agents)
        .where(eq(agents.id, agentId))
        .catch(() => {})
    }
    for (const agentTypeId of createdAgentTypeIds.splice(0)) {
      await db
        .delete(agentTypes)
        .where(eq(agentTypes.id, agentTypeId))
        .catch(() => {})
    }
  })

  async function drainAgentWrites(): Promise<void> {
    while (pendingAgentWrites.size > 0) await Promise.allSettled([...pendingAgentWrites])
  }

  async function mustComplete(promise: Promise<void>, message: string): Promise<void> {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), 1_000)),
    ])
  }

  async function createRunningExecution(model: string) {
    const agentTypeId = `provider-failover-${randomUUID()}`
    createdAgentTypeIds.push(agentTypeId)
    const agentType = await AgentType.create({
      id: agentTypeId,
      name: 'Provider Failover Worker',
      model,
      systemPrompt: 'You are a provider failover test worker.',
    })
    const agent = await Agent.create({ agentTypeId })
    const updateAgent = agent.update.bind(agent)
    agent.update = ((...args: Parameters<typeof agent.update>) => {
      const write = (async () => {
        const updated = await updateAgent(...args)
        await agentWriteCompletionHook?.()
        return updated
      })()
      pendingAgentWrites.add(write)
      void write.then(
        () => pendingAgentWrites.delete(write),
        () => pendingAgentWrites.delete(write)
      )
      return write
    }) as typeof agent.update
    createdAgentIds.push(agent.id)
    const [row] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'running', message: 'failover test' })
      .returning()
    const execution = await (await import('../../entities/Execution')).Execution.mustFind(row.id)
    createdExecutionIds.push(execution.id)
    return { agent, agentType, execution }
  }

  test('run reconciles the pickup slot to the session-selected provider', async () => {
    const { agent, execution } = await createRunningExecution('zai:glm-5.2')
    const mockSession = new MockAgentSession()
    ;(mockSession as any).selectedSpec = 'anthropic:claude-sonnet-4-5'
    const runner = new TestAgentRunner(
      execution,
      agent,
      makeAgentType({ id: agent.agentTypeId, model: 'zai:glm-5.2' }),
      mockSession
    )

    expect(concurrencyLimiter.tryAcquire(execution.id, 'zai', 'glm-5.2')).toBe(true)
    expect(concurrencyLimiter.getInFlight('zai')).toBe(1)

    await runner.run()

    expect(concurrencyLimiter.getInFlight('zai')).toBe(0)
    expect(concurrencyLimiter.getInFlight('anthropic', 'claude-sonnet-4-5')).toBe(1)
    concurrencyLimiter.release(execution.id)
  })

  test('failover moves the slot from the exhausted provider to the selected replacement', async () => {
    const ZAI = 'zai:glm-5.2'
    const ANTHROPIC = 'anthropic:claude-sonnet-4-5'
    const { agent, execution } = await createRunningExecution(`${ZAI},${ANTHROPIC}`)
    const mockSession = new MockAgentSession()
    ;(mockSession as any).selectedSpec = ZAI
    const runner = new TestAgentRunner(
      execution,
      agent,
      makeAgentType({ id: agent.agentTypeId, model: `${ZAI},${ANTHROPIC}` }),
      mockSession
    )
    const eligibleReplacement = {
      spec: ANTHROPIC,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      usable: true,
    }
    selectModelSpy = spyOn(modelSelection, 'selectModelSpecForCurrentEnv').mockReturnValue({
      selected: ANTHROPIC,
      candidates: [eligibleReplacement],
    })

    expect(ZAI).not.toBe(ANTHROPIC)
    expect(eligibleReplacement).toMatchObject({ spec: ANTHROPIC, usable: true })
    expect(providerHealth.isProviderHealthy('anthropic')).toBe(true)
    expect(concurrencyLimiter.tryAcquire(execution.id, 'zai', 'glm-5.2')).toBe(true)
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(true)
    expect(concurrencyLimiter.getInFlight('zai', 'glm-5.2')).toBe(1)
    expect(concurrencyLimiter.getInFlight('anthropic', 'claude-sonnet-4-5')).toBe(0)

    const redispatched = Promise.withResolvers<void>()
    mockSession.pi.prompt = async (text, options) => {
      mockSession.pi.promptCalls.push({ text, options })
      if (mockSession.pi.promptCalls.length === 2) redispatched.resolve()
    }

    await runner.run()
    expect(concurrencyLimiter.getInFlight('zai', 'glm-5.2')).toBe(1)

    const transferCommitted = Promise.withResolvers<void>()
    const reassign = concurrencyLimiter.reassign.bind(concurrencyLimiter)
    reassignSpy = spyOn(concurrencyLimiter, 'reassign').mockImplementation((executionId, provider, modelId) => {
      reassign(executionId, provider, modelId)
      if (executionId === execution.id && provider === 'anthropic' && modelId === 'claude-sonnet-4-5') {
        transferCommitted.resolve()
      }
    })

    mockSession.pi.simulateErrorEnd('rate limit exceeded')
    await mustComplete(transferCommitted.promise, 'replacement slot transfer was not committed')

    expect(reassignSpy).toHaveBeenCalledTimes(1)
    expect(reassignSpy).toHaveBeenCalledWith(execution.id, 'anthropic', 'claude-sonnet-4-5')
    expect(selectModelSpy).toHaveBeenCalledWith(`${ZAI},${ANTHROPIC}`, expect.anything())
    expect(providerHealth.getHealth('zai')).toMatchObject({ state: 'exhausted', reason: 'rate-limit' })
    expect(providerHealth.isProviderHealthy('anthropic')).toBe(true)
    expect(mockSession.pi.setModelCalls).toHaveLength(1)
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(true)
    expect(concurrencyLimiter.getInFlight('zai', 'glm-5.2')).toBe(0)
    expect(concurrencyLimiter.getInFlight('anthropic', 'claude-sonnet-4-5')).toBe(1)

    await mustComplete(redispatched.promise, 'replacement prompt was not redispatched')
    await mustComplete(runner.waitForFailoverAttempts(1), 'successful failover attempt did not finish')
    expect(mockSession.pi.promptCalls).toHaveLength(2)
    expect((await Agent.find(agent.id))?.selectedModel).toBe(ANTHROPIC)
    expect((await (await import('../../entities/Execution')).Execution.find(execution.id))?.status).toBe('running')
    concurrencyLimiter.release(execution.id)
  })

  test('delayed replacement keeps the old slot until the model switch completes', async () => {
    const ZAI = 'zai:glm-5.2'
    const ANTHROPIC = 'anthropic:claude-sonnet-4-5'
    const { agent, execution } = await createRunningExecution(`${ZAI},${ANTHROPIC}`)
    const mockSession = new MockAgentSession()
    ;(mockSession as any).selectedSpec = ZAI
    const runner = new TestAgentRunner(
      execution,
      agent,
      makeAgentType({ id: agent.agentTypeId, model: `${ZAI},${ANTHROPIC}` }),
      mockSession
    )
    selectModelSpy = spyOn(modelSelection, 'selectModelSpecForCurrentEnv').mockReturnValue({
      selected: ANTHROPIC,
      candidates: [],
    })
    expect(concurrencyLimiter.tryAcquire(execution.id, 'zai', 'glm-5.2')).toBe(true)
    await runner.run()

    const finishAgentWrite = Promise.withResolvers<void>()
    agentWriteCompletionHook = () => finishAgentWrite.promise
    const switchStarted = Promise.withResolvers<void>()
    const finishSwitch = Promise.withResolvers<void>()
    mockSession.pi.setModel = async () => {
      switchStarted.resolve()
      await finishSwitch.promise
    }
    const transferCommitted = Promise.withResolvers<void>()
    const reassign = concurrencyLimiter.reassign.bind(concurrencyLimiter)
    reassignSpy = spyOn(concurrencyLimiter, 'reassign').mockImplementation((executionId, provider, modelId) => {
      reassign(executionId, provider, modelId)
      if (executionId === execution.id && provider === 'anthropic') transferCommitted.resolve()
    })

    mockSession.pi.simulateErrorEnd('rate limit exceeded')
    await mustComplete(switchStarted.promise, 'replacement model switch did not start')
    expect(concurrencyLimiter.getInFlight('zai', 'glm-5.2')).toBe(1)
    expect(concurrencyLimiter.getInFlight('anthropic', 'claude-sonnet-4-5')).toBe(0)

    finishSwitch.resolve()
    await mustComplete(transferCommitted.promise, 'delayed replacement slot transfer was not committed')
    await mustComplete(mockSession.pi.waitForPromptCalls(2), 'delayed replacement was not redispatched')
    await mustComplete(runner.waitForFailoverAttempts(1), 'delayed failover attempt did not finish')
    expect(pendingAgentWrites.size).toBe(1)
    finishAgentWrite.resolve()
    await mustComplete(drainAgentWrites(), 'delayed failover agent write did not drain')
    expect(pendingAgentWrites.size).toBe(0)
    agentWriteCompletionHook = undefined
    expect(concurrencyLimiter.getInFlight('zai', 'glm-5.2')).toBe(0)
    expect(concurrencyLimiter.getInFlight('anthropic', 'claude-sonnet-4-5')).toBe(1)
  })

  test('replacement failure preserves the old slot and does not leak replacement ownership', async () => {
    const ZAI = 'zai:glm-5.2'
    const ANTHROPIC = 'anthropic:claude-sonnet-4-5'
    const { agent, execution } = await createRunningExecution(`${ZAI},${ANTHROPIC}`)
    const mockSession = new MockAgentSession()
    ;(mockSession as any).selectedSpec = ZAI
    mockSession.pi.setModel = async () => {
      throw new Error('replacement rejected')
    }
    const runner = new TestAgentRunner(
      execution,
      agent,
      makeAgentType({ id: agent.agentTypeId, model: `${ZAI},${ANTHROPIC}` }),
      mockSession
    )
    selectModelSpy = spyOn(modelSelection, 'selectModelSpecForCurrentEnv').mockReturnValue({
      selected: ANTHROPIC,
      candidates: [],
    })
    expect(concurrencyLimiter.tryAcquire(execution.id, 'zai', 'glm-5.2')).toBe(true)
    await runner.run()

    mockSession.pi.simulateErrorEnd('rate limit exceeded')
    await mustComplete(runner.waitForError(), 'replacement failure was not surfaced')

    expect(concurrencyLimiter.getInFlight('zai', 'glm-5.2')).toBe(1)
    expect(concurrencyLimiter.getInFlight('anthropic', 'claude-sonnet-4-5')).toBe(0)
    expect((await Agent.find(agent.id))?.selectedModel).not.toBe(ANTHROPIC)
  })

  test('concurrent failovers transfer atomically when replacement capacity is saturated and cancellation cleans up', async () => {
    ;(concurrencyLimiter as any).limits['anthropic/claude-sonnet-4-5'] = 1
    const ZAI = 'zai:glm-5.2'
    const ANTHROPIC = 'anthropic:claude-sonnet-4-5'
    const first = await createRunningExecution(`${ZAI},${ANTHROPIC}`)
    const second = await createRunningExecution(`${ZAI},${ANTHROPIC}`)
    const firstSession = new MockAgentSession()
    const secondSession = new MockAgentSession()
    ;(firstSession as any).selectedSpec = ZAI
    ;(secondSession as any).selectedSpec = ZAI
    const firstRunner = new TestAgentRunner(
      first.execution,
      first.agent,
      makeAgentType({ id: first.agent.agentTypeId, model: `${ZAI},${ANTHROPIC}` }),
      firstSession
    )
    const secondRunner = new TestAgentRunner(
      second.execution,
      second.agent,
      makeAgentType({ id: second.agent.agentTypeId, model: `${ZAI},${ANTHROPIC}` }),
      secondSession
    )
    selectModelSpy = spyOn(modelSelection, 'selectModelSpecForCurrentEnv').mockReturnValue({
      selected: ANTHROPIC,
      candidates: [],
    })
    expect(concurrencyLimiter.tryAcquire(first.execution.id, 'zai', 'glm-5.2')).toBe(true)
    expect(concurrencyLimiter.tryAcquire(second.execution.id, 'zai', 'glm-5.2')).toBe(true)
    await Promise.all([firstRunner.run(), secondRunner.run()])

    const bothTransferred = Promise.withResolvers<void>()
    const transferred = new Set<string>()
    const reassign = concurrencyLimiter.reassign.bind(concurrencyLimiter)
    reassignSpy = spyOn(concurrencyLimiter, 'reassign').mockImplementation((executionId, provider, modelId) => {
      reassign(executionId, provider, modelId)
      if (provider === 'anthropic' && modelId === 'claude-sonnet-4-5') transferred.add(executionId)
      if (transferred.size === 2) bothTransferred.resolve()
    })
    firstSession.pi.simulateErrorEnd('rate limit exceeded')
    secondSession.pi.simulateErrorEnd('rate limit exceeded')
    await mustComplete(bothTransferred.promise, 'concurrent transfers did not commit')
    await Promise.all([
      mustComplete(firstSession.pi.waitForPromptCalls(2), 'first failover was not redispatched'),
      mustComplete(secondSession.pi.waitForPromptCalls(2), 'second failover was not redispatched'),
      mustComplete(firstRunner.waitForFailoverAttempts(1), 'first concurrent failover did not finish'),
      mustComplete(secondRunner.waitForFailoverAttempts(1), 'second concurrent failover did not finish'),
    ])

    expect(transferred).toEqual(new Set([first.execution.id, second.execution.id]))
    expect(concurrencyLimiter.getInFlight('zai', 'glm-5.2')).toBe(0)
    expect(concurrencyLimiter.getInFlight('anthropic', 'claude-sonnet-4-5')).toBe(2)
    concurrencyLimiter.release(first.execution.id)
    expect(concurrencyLimiter.hasSlot(first.execution.id)).toBe(false)
    expect(concurrencyLimiter.hasSlot(second.execution.id)).toBe(true)
    expect(concurrencyLimiter.getInFlight('anthropic', 'claude-sonnet-4-5')).toBe(1)
  })

  test('a repeated settled error does not duplicate replacement ownership', async () => {
    const ZAI = 'zai:glm-5.2'
    const ANTHROPIC = 'anthropic:claude-sonnet-4-5'
    const { agent, execution } = await createRunningExecution(`${ZAI},${ANTHROPIC}`)
    const mockSession = new MockAgentSession()
    ;(mockSession as any).selectedSpec = ZAI
    const runner = new TestAgentRunner(
      execution,
      agent,
      makeAgentType({ id: agent.agentTypeId, model: `${ZAI},${ANTHROPIC}` }),
      mockSession
    )
    selectModelSpy = spyOn(modelSelection, 'selectModelSpecForCurrentEnv').mockReturnValue({
      selected: ANTHROPIC,
      candidates: [],
    })
    expect(concurrencyLimiter.tryAcquire(execution.id, 'zai', 'glm-5.2')).toBe(true)
    await runner.run()
    const firstTransfer = Promise.withResolvers<void>()
    const reassign = concurrencyLimiter.reassign.bind(concurrencyLimiter)
    reassignSpy = spyOn(concurrencyLimiter, 'reassign').mockImplementation((executionId, provider, modelId) => {
      reassign(executionId, provider, modelId)
      firstTransfer.resolve()
    })

    mockSession.pi.simulateErrorEnd('rate limit exceeded')
    await mustComplete(firstTransfer.promise, 'first transfer did not commit')
    await mustComplete(mockSession.pi.waitForPromptCalls(2), 'first failover was not redispatched')
    await mustComplete(runner.waitForFailoverAttempts(1), 'first failover attempt did not finish')
    mockSession.pi.simulateErrorEnd('rate limit exceeded')
    await mustComplete(runner.waitForError(), 'repeated failover error was not surfaced')
    await mustComplete(runner.waitForFailoverAttempts(2), 'repeated failover attempt did not finish')

    expect(reassignSpy).toHaveBeenCalledTimes(1)
    expect(concurrencyLimiter.getInFlight('zai', 'glm-5.2')).toBe(0)
    expect(concurrencyLimiter.getInFlight('anthropic', 'claude-sonnet-4-5')).toBe(1)
    concurrencyLimiter.release(execution.id)
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(false)
    expect(concurrencyLimiter.getInFlight('anthropic', 'claude-sonnet-4-5')).toBe(0)
  })
})
