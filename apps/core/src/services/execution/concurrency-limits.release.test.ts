import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db } from '../../db'
import { agents, agentTypes, executions, messages } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { concurrencyLimiter } from './concurrency-limiter-instance'
import { registerConcurrencyReleaseListenersForTest } from '../../worker'

describe('provider concurrency slot release', () => {
  const createdAgentIds: string[] = []
  const createdAgentTypeIds: string[] = []

  beforeEach(() => {
    concurrencyLimiter.reset()
  })

  afterEach(async () => {
    concurrencyLimiter.release('terminal-execution')
    concurrencyLimiter.reset()
    for (const agentId of createdAgentIds.splice(0)) {
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

  test('terminal execution events release the acquired provider slot', () => {
    const cleanup = registerConcurrencyReleaseListenersForTest()
    try {
      expect(concurrencyLimiter.tryAcquire('terminal-execution', 'zai', 'glm-5.2')).toBe(true)
      expect(concurrencyLimiter.hasSlot('terminal-execution')).toBe(true)

      eventEmitter.emit('execution.completed', {
        executionId: 'terminal-execution',
        agentId: 'agent-id',
        status: 'completed',
      })

      expect(concurrencyLimiter.hasSlot('terminal-execution')).toBe(false)
    } finally {
      cleanup()
    }
  })

  test('Execution.requeue releases the acquired provider slot', async () => {
    const agentTypeId = `provider-release-${randomUUID()}`
    createdAgentTypeIds.push(agentTypeId)
    await AgentType.create({
      id: agentTypeId,
      name: 'Provider Release Worker',
      model: 'zai:glm-5.2',
      systemPrompt: 'You are a release test worker.',
    })
    const agent = await Agent.create({ agentTypeId })
    createdAgentIds.push(agent.id)
    const execution = await agent.queueExecution({ message: 'release on requeue' })

    expect(concurrencyLimiter.tryAcquire(execution.id, 'zai', 'glm-5.2')).toBe(true)
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(true)

    await execution.requeue()

    // hasSlot verifies that this execution released ownership. Aggregate provider accounting is
    // covered in concurrency-limits.test.ts; process-global counts are not appropriate ownership
    // assertions when tests run in parallel.
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(false)
  })
})
