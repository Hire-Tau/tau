import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import { agents, agentTypes, executions, messages as messagesTable, squads } from '../../../db/schema'
import { Agent } from '../../../entities/Agent'
import { AgentType } from '../../../entities/AgentType'
import { Squad } from '../../../entities/Squad'
import { registerSession, removeSession, isSessionActive } from '../../execution/session-state'
import { sandboxRecoveryWatch } from '../recovery-watch'
import { K8sSandboxManager } from './manager'

/**
 * Tests for reconcileActiveSessionSandboxes: with the recovery watch in place,
 * a dead box under an active session must NOT halt the execution — it registers
 * a watch and leaves the session alone.
 */
describe('reconcileActiveSessionSandboxes', () => {
  let agentTypeId: string
  let squadId: string | null = null
  const sessionAgentIds: string[] = []

  beforeEach(async () => {
    agentTypeId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    await AgentType.create({
      id: agentTypeId,
      model: 'anthropic:claude-haiku-4-5',
      name: 'Reconcile Test',
      systemPrompt: 'test',
    })
  })

  afterEach(async () => {
    for (const id of sessionAgentIds.splice(0)) removeSession(id)
    const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.agentTypeId, agentTypeId))
    for (const r of rows) {
      await db.delete(messagesTable).where(eq(messagesTable.agentId, r.id))
      await db.delete(executions).where(eq(executions.agentId, r.id))
      await db.delete(agents).where(eq(agents.id, r.id))
    }
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    if (squadId) {
      await db.delete(squads).where(eq(squads.id, squadId))
      squadId = null
    }
  })

  async function runningAgent(opts: { squadId?: string } = {}) {
    const agent = await Agent.create({ agentTypeId, ...(opts.squadId ? { squadId: opts.squadId } : {}) })
    const exec = await agent.queueExecution({ message: 'go' })
    await exec.update({ status: 'running' })
    registerSession(agent.id, {
      session: {} as never,
      collector: {} as never,
      buffer: {} as never,
      agentId: agent.id,
      executionId: exec.id,
    })
    sessionAgentIds.push(agent.id)
    return { agent, exec }
  }

  function reconcile(statusBySandboxId: Record<string, { status: string; reason?: string }>) {
    const fakeThis = {
      getSandboxStatus: mock(async (sandboxId: string) => statusBySandboxId[sandboxId] ?? { status: 'not_found' }),
    }
    return (K8sSandboxManager.prototype as never as Record<string, (this: unknown) => Promise<void>>)[
      'reconcileActiveSessionSandboxes'
    ].call(fakeThis)
  }

  it('registers a recovery watch instead of halting when an active session loses its box', async () => {
    const registerSpy = spyOn(sandboxRecoveryWatch, 'register').mockResolvedValue(undefined)
    try {
      const { agent, exec } = await runningAgent()
      const sandboxId = await agent.getSandboxId()

      await reconcile({ [sandboxId]: { status: 'failed', reason: 'OOMKilled' } })

      expect(registerSpy).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: agent.id, sandboxIds: [sandboxId], crash: true, reason: 'OOMKilled' })
      )
      // Session and execution are left alone
      expect(isSessionActive(agent.id)).toBe(true)
      await agent.reload()
      expect(agent.status).not.toBe('waiting-input')
      await exec.reload()
      expect(exec.status).toBe('running')
    } finally {
      registerSpy.mockRestore()
    }
  })

  it('also checks the squad box for squad members and watches it when dead', async () => {
    const registerSpy = spyOn(sandboxRecoveryWatch, 'register').mockResolvedValue(undefined)
    try {
      const squad = await Squad.create({ name: 'reconcile-test-squad', purpose: 'test' })
      squadId = squad.id
      const { agent } = await runningAgent({ squadId: squad.id })
      const ownBoxId = await agent.getSandboxId()

      await reconcile({
        [ownBoxId]: { status: 'running' },
        [Squad.getSandboxId(squad.id)]: { status: 'failed', reason: 'OOMKilled' },
      })

      expect(registerSpy).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: agent.id, sandboxIds: [Squad.getSandboxId(squad.id)], crash: true })
      )
      expect(isSessionActive(agent.id)).toBe(true)
    } finally {
      registerSpy.mockRestore()
    }
  })

  it('does nothing when all boxes are healthy', async () => {
    const registerSpy = spyOn(sandboxRecoveryWatch, 'register').mockResolvedValue(undefined)
    try {
      const { agent } = await runningAgent()
      const sandboxId = await agent.getSandboxId()

      await reconcile({ [sandboxId]: { status: 'running' } })

      expect(registerSpy).not.toHaveBeenCalled()
      expect(isSessionActive(agent.id)).toBe(true)
    } finally {
      registerSpy.mockRestore()
    }
  })
})

/**
 * The 60s reconcile pass is fleet-wide maintenance: active-squad scans,
 * per-pod health calls, bashrc writes, work-stream warmup. Both entry points
 * build their own K8sSandboxManager (index.ts / worker.ts), so every tick ran
 * twice — identical DB and cluster work in each process. Only the claiming
 * process (the worker, mirroring the vm lifecycle runner) arms it now.
 *
 * The pod manager's idle sweep shares the 60s cadence and is deliberately left
 * armed in both processes: it reaps only the pods its own process tracks.
 */
describe('periodic reconcile ownership', () => {
  function armedSixtySecondTimers(run: () => void): number {
    const spy = spyOn(globalThis, 'setInterval')
    try {
      run()
      return spy.mock.calls.filter((call) => call[1] === 60_000).length
    } finally {
      spy.mockRestore()
    }
  }

  it('arms only the pod idle sweep when the process does not own periodic maintenance', async () => {
    let manager: K8sSandboxManager | null = null
    const armed = armedSixtySecondTimers(() => {
      manager = new K8sSandboxManager('test', { runPeriodicLoops: false })
    })
    try {
      expect(armed).toBe(1)
    } finally {
      await manager!.cleanup()
      ;(manager as unknown as { podManager: { destroy: () => void } }).podManager.destroy()
    }
  })

  it('arms the reconcile loop on top of the idle sweep in the owning process', async () => {
    let manager: K8sSandboxManager | null = null
    const armed = armedSixtySecondTimers(() => {
      manager = new K8sSandboxManager('test', { runPeriodicLoops: true })
    })
    try {
      expect(armed).toBe(2)
    } finally {
      await manager!.cleanup()
      ;(manager as unknown as { podManager: { destroy: () => void } }).podManager.destroy()
    }
  })
})
