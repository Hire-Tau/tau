import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import { agents, agentTypes, executions, messages as messagesTable, squads } from '../../../db/schema'
import { Agent } from '../../../entities/Agent'
import { AgentType } from '../../../entities/AgentType'
import { drainSandboxHaltedAgentsOnce, defaultIsSandboxReady } from './resume'
import { META_COUNT, SANDBOX_RESTART_QUESTION_ID } from './types'
import * as sandboxFactory from '../factory'
import * as ensureModule from '../ensure'

describe('drainSandboxHaltedAgentsOnce', () => {
  let agentTypeId: string

  beforeEach(async () => {
    agentTypeId = `res-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    await AgentType.create({
      id: agentTypeId,
      model: 'anthropic:claude-haiku-4-5',
      name: 'Resume Test',
      systemPrompt: 'test',
    })
  })

  afterEach(async () => {
    const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.agentTypeId, agentTypeId))
    for (const r of rows) {
      await db.delete(messagesTable).where(eq(messagesTable.agentId, r.id))
      await db.delete(executions).where(eq(executions.agentId, r.id))
      await db.delete(agents).where(eq(agents.id, r.id))
    }
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  })

  function sentinelQuestionData() {
    return {
      questions: [
        {
          id: SANDBOX_RESTART_QUESTION_ID,
          type: 'select' as const,
          question: 'Sandbox restarting',
          optional: true,
          options: [{ value: 'Continue', label: 'Continue' }],
        },
      ],
    }
  }

  async function haltedAgent(opts: { terminatedAt?: Date | null; metadata?: Record<string, unknown> } = {}) {
    const agent = await Agent.create({ agentTypeId })
    const exec = await agent.queueExecution({ message: 'go' })
    await exec.transitionTo({ kind: 'failed', error: 'Interrupted: sandbox restarting' })
    await agent.update({
      status: 'waiting-input',
      questionData: sentinelQuestionData(),
      ...(opts.metadata ? { metadata: { ...agent.metadata, ...opts.metadata } } : {}),
    })
    if (opts.terminatedAt !== undefined) {
      await agent.update({ status: 'terminated', terminatedAt: opts.terminatedAt })
    }
    return agent
  }

  it('resumes a sandbox-halted agent when its sandbox is ready', async () => {
    const agent = await haltedAgent({ metadata: { [META_COUNT]: 1 } })

    await drainSandboxHaltedAgentsOnce({ isSandboxReady: async () => true })

    await agent.reload()
    expect(agent.status).not.toBe('waiting-input')
    expect(agent.questionData).toBeNull()
    const active = await agent.getActiveExecution()
    expect(active?.status).toBe('queued')
    const msgs = await agent.listMessages()
    expect(msgs.messages.some((m) => /recreated and is ready/i.test(m.content))).toBe(true)
  })

  it('does not resume when the sandbox is not ready', async () => {
    const agent = await haltedAgent()

    await drainSandboxHaltedAgentsOnce({ isSandboxReady: async () => false })

    await agent.reload()
    expect(agent.status).toBe('waiting-input')
    expect(await agent.getActiveExecution()).toBeNull()
  })

  it('does not resume a terminated agent', async () => {
    const agent = await haltedAgent({ terminatedAt: new Date() })

    await drainSandboxHaltedAgentsOnce({ isSandboxReady: async () => true })

    await agent.reload()
    expect(agent.status).toBe('terminated')
    expect(await agent.getActiveExecution()).toBeNull()
  })

  it('does not resume when a user already queued an execution', async () => {
    const agent = await haltedAgent()
    await agent.clearWaitingInput()
    const queued = await agent.queueExecution({ message: 'user clicked continue' })
    await agent.update({ status: 'waiting-input', questionData: sentinelQuestionData() })

    await drainSandboxHaltedAgentsOnce({ isSandboxReady: async () => true })

    const active = await agent.getActiveExecution()
    expect(active?.id).toBe(queued.id)
  })

  it('leaves non-sentinel waiting-input agents untouched', async () => {
    const agent = await Agent.create({ agentTypeId })
    await agent.update({
      status: 'waiting-input',
      questionData: { questions: [{ id: 'ask_human', type: 'text', question: 'What now?' }] },
    })

    await drainSandboxHaltedAgentsOnce({ isSandboxReady: async () => true })

    await agent.reload()
    expect(agent.status).toBe('waiting-input')
    expect(await agent.getActiveExecution()).toBeNull()
  })

  it('leaves idle agents without the sentinel untouched', async () => {
    const agent = await Agent.create({ agentTypeId })

    await drainSandboxHaltedAgentsOnce({ isSandboxReady: async () => true })

    await agent.reload()
    expect(agent.status).toBe('idle')
    expect(await agent.getActiveExecution()).toBeNull()
  })
})

describe('defaultIsSandboxReady', () => {
  let agentTypeId: string

  beforeEach(async () => {
    agentTypeId = `rr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    await AgentType.create({
      id: agentTypeId,
      model: 'anthropic:claude-haiku-4-5',
      name: 'Ready Test',
      systemPrompt: 'test',
    })
  })

  afterEach(async () => {
    const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.agentTypeId, agentTypeId))
    for (const r of rows) {
      await db.delete(messagesTable).where(eq(messagesTable.agentId, r.id))
      await db.delete(executions).where(eq(executions.agentId, r.id))
    }
    await db.delete(agents).where(eq(agents.agentTypeId, agentTypeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  })

  function mockDockerManager(hasSandboxResult = true) {
    return {
      ensureSandbox: async () => '/workspace',
      hasSandbox: () => hasSandboxResult,
    }
  }

  it('solo agent: calls ensureWorkspaceSandbox without squadId', async () => {
    const agent = await Agent.create({ agentTypeId })
    const sandboxId = agent.getAgentWorkspaceSandboxId()

    const getSandboxManagerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue(mockDockerManager() as any)
    const isK8sRuntimeSpy = spyOn(sandboxFactory, 'isK8sRuntime').mockReturnValue(false)
    const ensureWorkspaceSandboxSpy = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockResolvedValue('/workspace')

    try {
      const ready = await defaultIsSandboxReady(sandboxId, agent)
      expect(ready).toBe(true)
      expect(ensureWorkspaceSandboxSpy).toHaveBeenCalledTimes(1)
      const call = ensureWorkspaceSandboxSpy.mock.calls[0][0] as any
      expect(call.sandboxId).toBe(sandboxId)
      expect(call.workspaceId).toBe(sandboxId)
      expect(call.squadId).toBeUndefined()
    } finally {
      getSandboxManagerSpy.mockRestore()
      isK8sRuntimeSpy.mockRestore()
      ensureWorkspaceSandboxSpy.mockRestore()
    }
  })

  it('squad agent: calls ensureSquadSandbox and ensureWorkspaceSandbox with squadId', async () => {
    // Insert a minimal squad row directly to avoid Squad.create side-effects
    const [squadRow] = await db
      .insert(squads)
      .values({
        name: 'test-squad-ready',
        purpose: 'test',
        metadata: {},
        defaultAgents: [],
        globalCollaborationEnabled: false,
        order: 0,
      })
      .returning()

    const agent = await Agent.create({ agentTypeId, squadId: squadRow.id })
    const sandboxId = agent.getAgentWorkspaceSandboxId()

    const getSandboxManagerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue(mockDockerManager() as any)
    const isK8sRuntimeSpy = spyOn(sandboxFactory, 'isK8sRuntime').mockReturnValue(false)
    const ensureSquadSandboxSpy = spyOn(ensureModule, 'ensureSquadSandbox').mockResolvedValue('/squad-workspace')
    const ensureWorkspaceSandboxSpy = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockResolvedValue('/workspace')

    try {
      const ready = await defaultIsSandboxReady(sandboxId, agent)
      expect(ready).toBe(true)
      expect(ensureSquadSandboxSpy).toHaveBeenCalledTimes(1)
      expect(ensureWorkspaceSandboxSpy).toHaveBeenCalledTimes(1)
      const call = ensureWorkspaceSandboxSpy.mock.calls[0][0] as any
      expect(call.sandboxId).toBe(sandboxId)
      expect(call.workspaceId).toBe(sandboxId)
      expect(call.squadId).toBe(squadRow.id)
    } finally {
      getSandboxManagerSpy.mockRestore()
      isK8sRuntimeSpy.mockRestore()
      ensureSquadSandboxSpy.mockRestore()
      ensureWorkspaceSandboxSpy.mockRestore()
      // Cleanup
      await db.delete(agents).where(eq(agents.squadId, squadRow.id))
      await db.delete(squads).where(eq(squads.id, squadRow.id))
    }
  })

  it('subagent: does NOT call ensureWorkspaceSandbox', async () => {
    // Create a parent agent, then a subagent with parentAgentId
    const parent = await Agent.create({ agentTypeId })
    const subagent = await Agent.create({ agentTypeId, parentAgentId: parent.id })
    // Subagent getSandboxId() delegates to parent; use parent's sandbox id
    const sandboxId = parent.getAgentWorkspaceSandboxId()

    const getSandboxManagerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue(mockDockerManager() as any)
    const isK8sRuntimeSpy = spyOn(sandboxFactory, 'isK8sRuntime').mockReturnValue(false)
    const ensureWorkspaceSandboxSpy = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockResolvedValue('/workspace')

    try {
      const ready = await defaultIsSandboxReady(sandboxId, subagent)
      expect(ready).toBe(true)
      expect(ensureWorkspaceSandboxSpy).not.toHaveBeenCalled()
    } finally {
      getSandboxManagerSpy.mockRestore()
      isK8sRuntimeSpy.mockRestore()
      ensureWorkspaceSandboxSpy.mockRestore()
      await db.delete(agents).where(eq(agents.parentAgentId, parent.id))
    }
  })
})
