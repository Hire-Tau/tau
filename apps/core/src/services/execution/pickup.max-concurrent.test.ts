import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'

// Real execution-lifecycle transitions with waitFor budgets, same rationale as
// pickup.test.ts.
setDefaultTimeout(30000)

import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db } from '../../db'
import {
  agents,
  agentTypes,
  executionAdmissionReservations,
  executions,
  messages,
  settings,
  squads,
} from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Execution } from '../../entities/Execution'
import { SquadWorkerRunner } from '../../entities/agent-runners/squad-worker-runner'
import { PROVIDERS_WITHOUT_AUTH } from '../model-selection/select-model'
import { getSettingsStore } from '../settings'
import {
  getActiveSessionCount,
  isSessionActive,
  releaseSessionReservation,
  removeSession,
  reserveSession,
} from './session-state'
import { MockAgentSession } from './test-helpers'
import { concurrencyLimiter } from './concurrency-limiter-instance'
import { executionLifecycleRegistry } from './lifecycle-registry'
import { attemptPickup, getMaxConcurrentAgents } from './pickup'
import { MAX_CONCURRENT_AGENTS_SETTING_KEY } from './max-concurrent'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
beforeAll(async () => {
  releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()
})
afterAll(() => releaseMaintenanceIsolation?.())

async function waitFor(
  check: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {}
): Promise<void> {
  const { timeoutMs = 5000, intervalMs = 50, description = 'condition' } = options
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

describe('pickup honours the MAX_CONCURRENT_AGENTS setting at decision time', () => {
  const createdAgentIds: string[] = []
  const createdExecutionIds: string[] = []
  const createdSquadIds: string[] = []
  const createdAgentTypeIds: string[] = []
  const reservations: Array<[string, string]> = []
  let createSessionSpy: ReturnType<typeof spyOn> | undefined
  let createdSessions: MockAgentSession[]
  let originalEnv: string | undefined

  beforeEach(async () => {
    originalEnv = process.env.MAX_CONCURRENT_AGENTS
    delete process.env.MAX_CONCURRENT_AGENTS
    concurrencyLimiter.reset()
    PROVIDERS_WITHOUT_AUTH.add('zai')
    createdSessions = []
    createSessionSpy = spyOn(SquadWorkerRunner.prototype as any, 'createSession').mockImplementation(async function (
      this: any,
      scope: any
    ) {
      return this.createPiSession(scope, async () => {
        const session = new MockAgentSession()
        ;(session as any).selectedSpec = await this.agent.getEffectiveModelSpec(this.agentType.model)
        createdSessions.push(session)
        return session as any
      })
    })
    await getSettingsStore().initialize()
    await getSettingsStore().delete(MAX_CONCURRENT_AGENTS_SETTING_KEY)
  })

  afterEach(async () => {
    for (const session of createdSessions) {
      session.pi.simulateNormalEnd('test cleanup')
    }
    await waitFor(
      async () => {
        for (const executionId of createdExecutionIds) {
          const execution = await Execution.find(executionId)
          if (execution?.status === 'running') return false
        }
        return true
      },
      { description: 'spawned pickup executions to settle during cleanup', timeoutMs: 5000 }
    ).catch(() => {})

    createSessionSpy?.mockRestore()
    createSessionSpy = undefined
    PROVIDERS_WITHOUT_AUTH.delete('zai')

    for (const [agentId, executionId] of reservations.splice(0)) {
      releaseSessionReservation(agentId, executionId)
    }
    const settlingExecutionIds = createdExecutionIds.splice(0)
    for (const executionId of settlingExecutionIds) {
      concurrencyLimiter.release(executionId)
      const lifecycle = executionLifecycleRegistry.get(executionId)
      lifecycle?.settle()
      lifecycle?.markRunnerFinished()
      await db.delete(executionAdmissionReservations).where(eq(executionAdmissionReservations.executionId, executionId))
    }
    concurrencyLimiter.reset()
    const settlingAgentIds = createdAgentIds.splice(0)
    for (const agentId of settlingAgentIds) {
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
    for (const squadId of createdSquadIds.splice(0)) {
      await db
        .delete(squads)
        .where(eq(squads.id, squadId))
        .catch(() => {})
    }
    await waitFor(
      async () =>
        settlingAgentIds.every((agentId) => !isSessionActive(agentId)) &&
        settlingExecutionIds.every((executionId) => executionLifecycleRegistry.get(executionId) === undefined),
      {
        description: 'active sessions and execution lifecycles to settle during cleanup',
        timeoutMs: 5000,
        intervalMs: 25,
      }
    )
    for (const agentTypeId of createdAgentTypeIds.splice(0)) {
      await db
        .delete(agentTypes)
        .where(eq(agentTypes.id, agentTypeId))
        .catch(() => {})
    }

    await db.delete(settings).where(eq(settings.key, MAX_CONCURRENT_AGENTS_SETTING_KEY))
    await getSettingsStore().initialize()
    if (originalEnv === undefined) delete process.env.MAX_CONCURRENT_AGENTS
    else process.env.MAX_CONCURRENT_AGENTS = originalEnv
  })

  async function createSquadAgent(): Promise<Agent> {
    const agentTypeId = `pickup-cap-${randomUUID()}`
    createdAgentTypeIds.push(agentTypeId)
    await AgentType.create({
      id: agentTypeId,
      name: 'Pickup Cap Worker',
      model: 'zai:glm-5.2',
      systemPrompt: 'You are a MAX_CONCURRENT_AGENTS test worker.',
    })

    const [squad] = await db
      .insert(squads)
      .values({ name: 'Pickup Cap Squad', purpose: 'Exercise the concurrency cap' })
      .returning()
    createdSquadIds.push(squad.id)

    const agent = await Agent.create({ agentTypeId, squadId: squad.id })
    createdAgentIds.push(agent.id)
    return agent
  }

  /**
   * Occupy one global slot without running anything real, and return the
   * resulting active-session count.
   *
   * Caps are expressed RELATIVE to this count, never as an absolute number:
   * `session-state` is a process-wide in-memory map and bun runs all 430 test
   * files in one process, so earlier files can leave sessions behind. The
   * admission rule under test (`active >= cap`) is unaffected — we just have
   * to aim the cap at the real count rather than assume it starts at zero.
   */
  function occupyOneSlot(): number {
    const before = getActiveSessionCount()
    const agentId = `cap-holder-${randomUUID()}`
    const executionId = `cap-holder-exec-${randomUUID()}`
    reserveSession(agentId, executionId)
    reservations.push([agentId, executionId])
    const after = getActiveSessionCount()
    expect(after).toBe(before + 1)
    return after
  }

  // THE headline test. Mutation caught: reading the cap from a module-level
  // `const MAX_CONCURRENT = ...` evaluated once at import — the raise below
  // would be invisible until the worker restarts, and this test would fail on
  // the second assertion. It also fails on the FIRST assertion if the stored
  // setting is ignored entirely (the old constant would admit at 30).
  test('raising the stored cap admits an execution that was just refused — same process, no re-import', async () => {
    const store = getSettingsStore()
    const agent = await createSquadAgent()
    const execution = await agent.queueExecution({ message: 'gated by the stored cap' })
    createdExecutionIds.push(execution.id)

    // Cap exactly at the number of occupied slots: zero headroom.
    const active = occupyOneSlot()

    await store.set(MAX_CONCURRENT_AGENTS_SETTING_KEY, String(active))
    expect(getMaxConcurrentAgents()).toBe(active)
    expect(await attemptPickup(execution)).toBe('no-capacity')
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')

    // Raise the cap through the ordinary settings path — nothing is restarted
    // and no module is re-imported between these two attemptPickup calls.
    await store.set(MAX_CONCURRENT_AGENTS_SETTING_KEY, String(active + 1))
    expect(getMaxConcurrentAgents()).toBe(active + 1)

    expect(await attemptPickup(execution)).toBe('started')
    await waitFor(async () => (await Execution.mustFind(execution.id)).status === 'running', {
      description: 'execution to start once the cap was raised',
    })
  })

  // The mirror direction: lowering the cap must start refusing immediately.
  // Mutation caught: caching the resolved cap after the first read.
  test('lowering the stored cap refuses an execution that would otherwise start', async () => {
    const store = getSettingsStore()
    const agent = await createSquadAgent()
    const execution = await agent.queueExecution({ message: 'refused after the cap drops' })
    createdExecutionIds.push(execution.id)

    const active = occupyOneSlot()
    await store.set(MAX_CONCURRENT_AGENTS_SETTING_KEY, String(active + 4))
    expect(getMaxConcurrentAgents()).toBe(active + 4)

    await store.set(MAX_CONCURRENT_AGENTS_SETTING_KEY, String(active))
    expect(getMaxConcurrentAgents()).toBe(active)
    expect(await attemptPickup(execution)).toBe('no-capacity')
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
  })

  // Mutation caught: making env win over the stored value — this instance runs
  // MAX_CONCURRENT_AGENTS=20, so the UI control would be a silent no-op.
  test('a stored cap overrides the env var', async () => {
    const store = getSettingsStore()
    const agent = await createSquadAgent()
    const execution = await agent.queueExecution({ message: 'stored beats env' })
    createdExecutionIds.push(execution.id)

    const active = occupyOneSlot()
    process.env.MAX_CONCURRENT_AGENTS = String(active)

    // Env alone refuses...
    expect(getMaxConcurrentAgents()).toBe(active)
    expect(await attemptPickup(execution)).toBe('no-capacity')

    // ...and the stored value lifts that refusal, proving stored > env.
    await store.set(MAX_CONCURRENT_AGENTS_SETTING_KEY, String(active + 3))
    expect(getMaxConcurrentAgents()).toBe(active + 3)
    expect(await attemptPickup(execution)).toBe('started')
  })

  // Mutation caught: ignoring the env var once the setting exists — every real
  // deployment sets it, so this would silently raise their cap to 30.
  test('with nothing stored, the env var still governs pickup exactly as today', async () => {
    const store = getSettingsStore()
    await store.delete(MAX_CONCURRENT_AGENTS_SETTING_KEY)

    const agent = await createSquadAgent()
    const execution = await agent.queueExecution({ message: 'gated by env alone' })
    createdExecutionIds.push(execution.id)

    const active = occupyOneSlot()
    process.env.MAX_CONCURRENT_AGENTS = String(active)
    expect(getMaxConcurrentAgents()).toBe(active)
    expect(await attemptPickup(execution)).toBe('no-capacity')
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')

    // Raise env (as a restart with a new EnvironmentFile would) — still honoured.
    process.env.MAX_CONCURRENT_AGENTS = String(active + 2)
    expect(getMaxConcurrentAgents()).toBe(active + 2)
    expect(await attemptPickup(execution)).toBe('started')
  })

  // Mutation caught: `Number(stored) || Number(env) || 30`-style resolution at
  // the read path. A row written outside the API (SQL, an older build, a
  // migration) must never be able to produce a cap of 0 — which would refuse
  // EVERY execution instance-wide, even with zero sessions active.
  test('a malformed stored value that bypassed validation cannot produce a 0 cap', async () => {
    const store = getSettingsStore()
    for (const bad of ['0', '-5', 'banana', '999999999']) {
      // Write straight to the table, bypassing set()'s validator.
      await db
        .insert(settings)
        .values({ key: MAX_CONCURRENT_AGENTS_SETTING_KEY, value: bad, updatedAt: new Date(), updatedBy: 'sql' })
        .onConflictDoUpdate({ target: settings.key, set: { value: bad } })
      await store.initialize()

      expect(store.getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY)).toBe(bad)
      expect(getMaxConcurrentAgents()).toBe(30)
    }

    const agent = await createSquadAgent()
    const execution = await agent.queueExecution({ message: 'malformed row must not halt the instance' })
    createdExecutionIds.push(execution.id)
    // Precondition: the fallback cap of 30 genuinely leaves headroom, so a
    // refusal below could only come from a 0/negative cap.
    expect(getActiveSessionCount()).toBeLessThan(30)
    expect(await attemptPickup(execution)).toBe('started')
  })
})
