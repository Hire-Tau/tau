import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, executions } from '../../db/schema'
import { AgentType } from '../../entities/AgentType'
import { Agent } from '../../entities/Agent'
import { providerHealth, resetProviderHealthForTests } from './registry'
import { restartExhaustedAgentsOnce } from './auto-restart'
import * as accountStore from '../agent/account-store'

const PRIORITY_LIST = 'anthropic:claude-haiku-4-5,zai:glm-5-turbo'

function exhaustionQuestionData(id: string) {
  return {
    questions: [
      {
        id,
        type: 'select' as const,
        question: 'exhausted',
        optional: false,
        options: [{ value: 'Continue', label: 'Continue' }],
      },
    ],
  }
}

describe('restartExhaustedAgentsOnce', () => {
  let agentTypeId: string
  let accountStoreSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    resetProviderHealthForTests()
    accountStoreSpy = spyOn(accountStore, 'readAccountStore').mockReturnValue({
      version: 1,
      accounts: {
        anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-a1' } }],
        zai: [{ id: 'z1', enabled: true, credential: { type: 'api_key', key: 'sk-z1' } }],
      },
    })
    agentTypeId = `ar-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    await AgentType.create({
      id: agentTypeId,
      model: PRIORITY_LIST,
      name: 'Auto-Restart Test Type',
      systemPrompt: 'test',
    })
  })

  afterEach(async () => {
    accountStoreSpy.mockRestore()
    resetProviderHealthForTests()
    const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.agentTypeId, agentTypeId))
    for (const r of rows) {
      await db.delete(executions).where(eq(executions.agentId, r.id))
      await db.delete(agents).where(eq(agents.id, r.id))
    }
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  })

  async function makeWaitingInputAgent(opts: {
    questionId: string
    metadata?: Record<string, unknown>
    squadId?: string | null
  }): Promise<Agent> {
    const agent = await Agent.create({ agentTypeId, squadId: opts.squadId ?? null })
    // Create a failed execution (the one that put it into waiting-input).
    const exec = await agent.queueExecution({ message: 'go' })
    await exec.transitionTo({ kind: 'failed', error: 'provider exhausted' })
    await agent.update({
      status: 'waiting-input',
      questionData: exhaustionQuestionData(opts.questionId),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    })
    return agent
  }

  it('re-queues an all_providers_exhausted waiting-input agent when a provider recovers', async () => {
    // anthropic healthy (default), zai marked exhausted with passed retryAt → also healthy.
    // At least one provider in the list is healthy → restart proceeds.
    providerHealth.markExhausted('zai', { reason: 'rate-limit', retryAt: Date.now() - 1000 })
    const agent = await makeWaitingInputAgent({ questionId: 'all_providers_exhausted' })

    await restartExhaustedAgentsOnce()
    await agent.reload()

    expect(agent.status).not.toBe('waiting-input')
    expect(agent.questionData).toBeNull()
    const active = await agent.getActiveExecution()
    expect(active?.status).toBe('queued')
    // Backoff metadata persisted.
    expect(agent.metadata?.autoRestartCount).toBe(1)
    expect(agent.metadata?.lastAutoRestartAt).toBeGreaterThan(0)
  })

  it('does not restart when every concrete stored-account route is cooling', async () => {
    accountStoreSpy.mockReturnValue({
      version: 1,
      accounts: {
        anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-a1' } }],
        zai: [{ id: 'z1', enabled: true, credential: { type: 'api_key', key: 'sk-z1' } }],
      },
    })
    providerHealth.markAccountExhausted('anthropic', 'a1', { retryAt: Date.now() + 60_000 })
    providerHealth.markAccountExhausted('zai', 'z1', { retryAt: Date.now() + 60_000 })
    const agent = await makeWaitingInputAgent({ questionId: 'all_providers_exhausted' })

    await restartExhaustedAgentsOnce()
    await agent.reload()
    expect(agent.status).toBe('waiting-input')
  })

  it('does not restart when no provider in the priority list is healthy', async () => {
    providerHealth.markExhausted('anthropic', { reason: 'rate-limit', retryAt: Date.now() + 60_000 })
    providerHealth.markExhausted('zai', { reason: 'plan-credit', retryAt: Date.now() + 60_000 })
    const agent = await makeWaitingInputAgent({ questionId: 'all_providers_exhausted' })

    await restartExhaustedAgentsOnce()
    await agent.reload()

    expect(agent.status).toBe('waiting-input')
    const active = await agent.getActiveExecution()
    expect(active).toBeNull()
  })

  it('excludes ask_human waiting-input agents', async () => {
    const agent = await makeWaitingInputAgent({ questionId: 'ask_human' })

    await restartExhaustedAgentsOnce()
    await agent.reload()

    expect(agent.status).toBe('waiting-input')
    const active = await agent.getActiveExecution()
    expect(active).toBeNull()
  })

  it('excludes terminated agents', async () => {
    const agent = await makeWaitingInputAgent({ questionId: 'all_providers_exhausted' })
    await agent.update({ terminatedAt: new Date() })

    await restartExhaustedAgentsOnce()
    await agent.reload()

    expect(agent.status).toBe('terminated')
    const active = await agent.getActiveExecution()
    expect(active).toBeNull()
  })

  it('respects exponential backoff (no restart storm)', async () => {
    const agent = await makeWaitingInputAgent({
      questionId: 'all_providers_exhausted',
      metadata: { autoRestartCount: 2, lastAutoRestartAt: Date.now() },
    })

    await restartExhaustedAgentsOnce()
    await agent.reload()

    // Within the 60s * 2^2 = 240s backoff window → skipped.
    expect(agent.status).toBe('waiting-input')
    const active = await agent.getActiveExecution()
    expect(active).toBeNull()
    // Count unchanged.
    expect(agent.metadata?.autoRestartCount).toBe(2)
  })

  it('caps consecutive auto-restarts (count >= 5 → skip)', async () => {
    const agent = await makeWaitingInputAgent({
      questionId: 'all_providers_exhausted',
      metadata: { autoRestartCount: 5, lastAutoRestartAt: 0 },
    })

    await restartExhaustedAgentsOnce()
    await agent.reload()

    expect(agent.status).toBe('waiting-input')
    const active = await agent.getActiveExecution()
    expect(active).toBeNull()
  })

  it('skips agents that already have a queued execution (user clicked Continue)', async () => {
    const agent = await makeWaitingInputAgent({ questionId: 'all_providers_exhausted' })
    // Simulate the user resuming: clear waiting-input and queue a new execution.
    await agent.clearWaitingInput()
    await agent.update({ status: 'waiting-input' }) // still waiting-input in DB but with a queued exec
    await agent.queueExecution({ message: 'try again' })

    await restartExhaustedAgentsOnce()
    await agent.reload()

    // The pre-existing queued execution remains; no extra execution was added.
    const active = await agent.getActiveExecution()
    expect(active?.status).toBe('queued')
  })
})
