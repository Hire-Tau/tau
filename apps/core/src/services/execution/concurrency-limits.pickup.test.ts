import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, executions, messages, squads } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Execution } from '../../entities/Execution'
import { SquadWorkerRunner } from '../../entities/agent-runners/squad-worker-runner'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'
import { primaryFirstError } from '../../test-utils/primary-first-error'
import { maintenanceStore } from '../maintenance/store'
import { PROVIDERS_WITHOUT_AUTH } from '../model-selection/select-model'
import { concurrencyLimiter, resolveExecutionConcurrencyKey } from './concurrency-limiter-instance'
import { executionLifecycleRegistry, type ExecutionLifecycle } from './lifecycle-registry'
import { attemptPickup, sweepQueuedExecutionCandidates, type PickupResult } from './pickup'
import { getSession, removeSession } from './session-state'
import { ACTIVE_EXECUTION_STATUSES } from './status'
import { MockAgentSession } from './test-helpers'

async function releaseProviderSuiteResources(
  releaseForeignSlot: () => void | Promise<void>,
  releaseIsolation: () => void | Promise<void>,
  initialFailure?: unknown
): Promise<void> {
  let primary = initialFailure
  const secondary: Array<{ phase: string; error: unknown }> = []
  for (const [phase, release] of [
    ['provider-foreign-slot-release', releaseForeignSlot],
    ['provider-maintenance-isolation-release', releaseIsolation],
  ] as const) {
    try {
      await release()
    } catch (error) {
      if (primary === undefined) primary = error
      else secondary.push({ phase, error })
    }
  }
  if (primary !== undefined) {
    if (secondary.length === 0) throw primary
    throw primaryFirstError(primary, 'Provider pickup suite resource release failed', secondary)
  }
}

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
const foreignZaiExecutionId = `provider-limit-foreign-${randomUUID()}`
beforeAll(async () => {
  try {
    releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()
    // Exercise every invariant with a neighboring slot that this suite must preserve.
    concurrencyLimiter.reassign(foreignZaiExecutionId, 'zai', 'foreign-model')
  } catch (error) {
    await releaseProviderSuiteResources(
      () => concurrencyLimiter.release(foreignZaiExecutionId),
      async () => releaseMaintenanceIsolation?.(),
      error
    )
  }
})
afterAll(() =>
  releaseProviderSuiteResources(
    () => concurrencyLimiter.release(foreignZaiExecutionId),
    async () => releaseMaintenanceIsolation?.()
  )
)

// Lifecycle and interrupt barriers remain observable, but loaded CI runners have
// taken just over 5s to register a session; keep one explicit finite ceiling.
setDefaultTimeout(30000)

const RUNNER_OWNERSHIP_STATUSES = ACTIVE_EXECUTION_STATUSES.filter((status) => status !== 'queued')

interface PickupObservation {
  executionId: string
  agentId: string
  result: PickupResult
  status: string
  hasSlot: boolean
  zaiInFlight: number
  maintenanceCached: boolean
  effectiveKey: Awaited<ReturnType<typeof resolveExecutionConcurrencyKey>>
  limiterSnapshot: ReturnType<typeof concurrencyLimiter.snapshot>
}

class ProviderPickupFixture {
  readonly ownerId = randomUUID()
  readonly agentTypeIds = new Set<string>()
  readonly squadIds = new Set<string>()
  readonly agentIds = new Set<string>()
  readonly executionIds = new Set<string>()
  readonly sessions = new Map<string, MockAgentSession>()
  readonly lifecycles = new Map<string, ExecutionLifecycle>()
  readonly observations: PickupObservation[] = []
  private readonly sessionReady = new Map<string, (session: MockAgentSession) => void>()
  private readonly sessionPromises = new Map<string, Promise<MockAgentSession>>()
  private readonly originalCreateSession = (SquadWorkerRunner.prototype as any).createSession
  private readonly originalZaiLimit = (concurrencyLimiter as any).limits.zai as number | undefined
  private readonly entryZaiInFlight = concurrencyLimiter.getInFlight('zai')
  private readonly hadZaiExemption = PROVIDERS_WITHOUT_AUTH.has('zai')
  private readonly hadAnthropicExemption = PROVIDERS_WITHOUT_AUTH.has('anthropic')
  private createSessionSpy: ReturnType<typeof spyOn> | undefined
  private createSessionSpyRestorer: (() => void) | undefined
  private diagnosticDeps = { readMaintenance: () => maintenanceStore.read() }
  private lifecycleLookup = (executionId: string) => executionLifecycleRegistry.get(executionId)
  private sessionPublicationGate: { entered: () => void; waitForRelease: Promise<void> } | undefined

  setDiagnosticDeps(overrides: Partial<typeof this.diagnosticDeps>): void {
    this.diagnosticDeps = { ...this.diagnosticDeps, ...overrides }
  }

  setLifecycleLookup(lookup: typeof this.lifecycleLookup): void {
    this.lifecycleLookup = lookup
  }

  deferSessionPublication(): { entered: Promise<void>; release: () => void } {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    this.sessionPublicationGate = { entered: entered.resolve, waitForRelease: release.promise }
    return { entered: entered.promise, release: release.resolve }
  }

  setup(): void {
    ;(concurrencyLimiter as any).limits.zai = this.entryZaiInFlight + 1
    PROVIDERS_WITHOUT_AUTH.add('zai')
    PROVIDERS_WITHOUT_AUTH.add('anthropic')
    // The mock needs the runner as dynamic `this`; retain the owning fixture in the closure.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const fixture = this
    this.createSessionSpy = spyOn(SquadWorkerRunner.prototype as any, 'createSession').mockImplementation(
      async function (this: any, scope: unknown) {
        if (!fixture.agentIds.has(this.agent.id)) {
          return fixture.originalCreateSession.call(this, scope)
        }
        return this.createPiSession(scope, async () => {
          if (fixture.sessionPublicationGate) {
            fixture.sessionPublicationGate.entered()
            await fixture.sessionPublicationGate.waitForRelease
          }
          const session = new MockAgentSession()
          ;(session as any).selectedSpec = await this.agent.getEffectiveModelSpec(this.agentType.model)
          const executionId = this.execution.id as string
          fixture.sessions.set(executionId, session)
          fixture.sessionReady.get(executionId)?.(session)
          return session as any
        })
      }
    )
  }

  async assertMaintenanceBaseline(): Promise<void> {
    expect(maintenanceStore.isPausedCached()).toBe(false)
    expect((await maintenanceStore.read()).effective).toBe(false)
  }

  async createSquadAgent(model: string): Promise<Agent> {
    const agentTypeId = `provider-limit-${this.ownerId}-${randomUUID()}`
    this.agentTypeIds.add(agentTypeId)
    await AgentType.create({
      id: agentTypeId,
      name: `Provider Limit Worker ${this.ownerId}`,
      model,
      systemPrompt: 'You are a provider concurrency test worker.',
    })
    const [squad] = await db
      .insert(squads)
      .values({
        name: `Provider Limit Squad ${this.ownerId}`,
        purpose: `Exercise provider concurrency pickup ${this.ownerId}`,
      })
      .returning()
    this.squadIds.add(squad.id)
    const agent = await Agent.create({ agentTypeId, squadId: squad.id })
    this.agentIds.add(agent.id)
    return agent
  }

  async queue(agent: Agent): Promise<Execution> {
    const execution = await agent.queueExecution({})
    this.executionIds.add(execution.id)
    this.sessionPromises.set(
      execution.id,
      new Promise((resolve) => {
        this.sessionReady.set(execution.id, resolve)
      })
    )
    return execution
  }

  async pickup(execution: Execution): Promise<PickupResult> {
    const current = await Execution.mustFind(execution.id)
    const result = await attemptPickup(current)
    const updated = await Execution.mustFind(execution.id)
    this.observations.push({
      executionId: execution.id,
      agentId: execution.agentId,
      result,
      status: updated.status,
      hasSlot: concurrencyLimiter.hasSlot(execution.id),
      zaiInFlight: concurrencyLimiter.getInFlight('zai'),
      maintenanceCached: maintenanceStore.isPausedCached(),
      effectiveKey: await resolveExecutionConcurrencyKey(updated),
      limiterSnapshot: concurrencyLimiter.snapshot(),
    })
    return result
  }

  async expectPickup(execution: Execution, expected: PickupResult): Promise<void> {
    const actual = await this.pickup(execution)
    await this.assertInvariant(execution, () => expect(actual).toBe(expected))
  }

  async assertInvariant(candidate: Execution, assertion: () => void | Promise<void>): Promise<void> {
    try {
      await assertion()
    } catch (primary) {
      let diagnostics: string
      try {
        diagnostics = await this.collectInvariantDiagnostics(candidate)
      } catch (diagnosticError) {
        throw primaryFirstError(primary, `Provider pickup fixture ${this.ownerId} invariant failed`, [
          { phase: 'provider-invariant-diagnostics', error: diagnosticError },
        ])
      }
      throw new Error(`Provider pickup fixture ${this.ownerId} invariant failed\n${diagnostics}`, {
        cause: primary,
      })
    }
  }

  private async collectInvariantDiagnostics(candidate: Execution): Promise<string> {
    const ownedStatuses = await Promise.all(
      [...this.executionIds].map(async (executionId) => {
        const ownedExecution = await Execution.find(executionId)
        return {
          executionId,
          agentId: ownedExecution?.agentId ?? 'deleted',
          status: ownedExecution?.status ?? 'deleted',
          hasSlot: concurrencyLimiter.hasSlot(executionId),
          effectiveKey: ownedExecution ? await resolveExecutionConcurrencyKey(ownedExecution) : undefined,
        }
      })
    )
    return JSON.stringify(
      {
        candidateExecutionId: candidate.id,
        observations: this.observations,
        ownedStatuses,
        excludedNeighborRows: ownedStatuses.filter(({ executionId }) => executionId !== candidate.id),
        limiterSnapshot: concurrencyLimiter.snapshot(),
        maintenance: await this.diagnosticDeps.readMaintenance(),
      },
      null,
      2
    )
  }

  publishedSession(executionId: string): Promise<MockAgentSession> {
    const session = this.sessionPromises.get(executionId)
    if (!session) throw new Error(`No session barrier registered for owned execution ${executionId}`)
    return session
  }

  async waitForPrompt(executionId: string): Promise<MockAgentSession> {
    const session = this.sessions.get(executionId) ?? (await this.sessionPromises.get(executionId))
    if (!session) throw new Error(`No session barrier registered for owned execution ${executionId}`)
    await session.pi.waitForPromptCalls(1)
    const execution = await Execution.mustFind(executionId)
    expect(getSession(execution.agentId)?.executionId).toBe(executionId)
    const lifecycle = executionLifecycleRegistry.get(executionId)
    if (!lifecycle) throw new Error(`No lifecycle registered for owned execution ${executionId}`)
    this.lifecycles.set(executionId, lifecycle)
    return session
  }

  setCreateSessionSpyRestorer(restorer: (() => void) | undefined): void {
    this.createSessionSpyRestorer = restorer
  }

  assertGlobalsRestored(): void {
    expect((SquadWorkerRunner.prototype as any).createSession).toBe(this.originalCreateSession)
    expect(PROVIDERS_WITHOUT_AUTH.has('zai')).toBe(this.hadZaiExemption)
    expect(PROVIDERS_WITHOUT_AUTH.has('anthropic')).toBe(this.hadAnthropicExemption)
    expect((concurrencyLimiter as any).limits.zai).toBe(this.originalZaiLimit)
  }

  async finish(executionId: string, response: string): Promise<void> {
    const lifecycle = this.lifecycles.get(executionId) ?? executionLifecycleRegistry.get(executionId)
    if (!lifecycle) throw new Error(`No lifecycle registered for owned execution ${executionId}`)
    this.sessions.get(executionId)?.pi.simulateNormalEnd(response)
    await Promise.all([lifecycle.runnerFinished, lifecycle.settled])
    // A completed runner has authoritative lifecycle/session exit proof. Remove
    // its stale fixture observations so a later cleanup does not fail closed on
    // bookkeeping that no longer represents a live owner.
    this.sessions.delete(executionId)
    this.lifecycles.delete(executionId)
  }

  async cleanup(): Promise<void> {
    const errors: unknown[] = []
    const executionIds = [...this.executionIds]
    const quiescence = await Promise.allSettled(executionIds.map((executionId) => this.quiesceExecution(executionId)))
    const quiescenceFailures = quiescence.flatMap((result, index) =>
      result.status === 'rejected' ? [{ executionId: executionIds[index], error: result.reason }] : []
    )
    let primary = quiescenceFailures[0]?.error
    const secondaryFailures = quiescenceFailures.slice(1).map(({ executionId, error }) => ({
      phase: `provider-runner-quiescence-${executionId}`,
      error,
    }))
    const restore = async (phase: string, operation: () => void | Promise<void>) => {
      try {
        await operation()
      } catch (error) {
        if (primary === undefined) primary = error
        else secondaryFailures.push({ phase, error })
      }
    }

    // These process-global restorations are safe even when runner ownership is
    // indeterminate. Destructive session/row cleanup remains fenced below.
    let sessionSpyRestored = false
    await restore('provider-session-spy-restoration', () => {
      if (this.createSessionSpyRestorer) this.createSessionSpyRestorer()
      else this.createSessionSpy?.mockRestore()
      sessionSpyRestored = true
    })
    if (sessionSpyRestored) this.createSessionSpy = undefined
    await restore('provider-zai-exemption-restoration', () => this.restoreExemption('zai', this.hadZaiExemption))
    await restore('provider-anthropic-exemption-restoration', () =>
      this.restoreExemption('anthropic', this.hadAnthropicExemption)
    )
    for (const executionId of this.executionIds) {
      await restore(`provider-limiter-slot-release-${executionId}`, () => concurrencyLimiter.release(executionId))
    }
    await restore('provider-zai-limit-restoration', () => {
      if (this.originalZaiLimit === undefined) delete (concurrencyLimiter as any).limits.zai
      else (concurrencyLimiter as any).limits.zai = this.originalZaiLimit
    })

    if (primary !== undefined) {
      if (secondaryFailures.length === 0) throw primary
      throw primaryFirstError(
        primary,
        `Provider pickup fixture ${this.ownerId} cleanup restoration failed`,
        secondaryFailures
      )
    }

    if (!concurrencyLimiter.hasSlot(foreignZaiExecutionId)) {
      errors.push(new Error(`Foreign Z.ai slot was released: ${foreignZaiExecutionId}`))
    }
    if (concurrencyLimiter.getInFlight('zai') !== this.entryZaiInFlight) {
      errors.push(
        new Error(
          `Foreign Z.ai count changed: expected ${this.entryZaiInFlight}, received ${concurrencyLimiter.getInFlight('zai')}`
        )
      )
    }
    for (const agentId of this.agentIds) {
      removeSession(agentId)
      try {
        await db.delete(messages).where(eq(messages.agentId, agentId))
        await db.delete(executions).where(eq(executions.agentId, agentId))
        await db.delete(agents).where(eq(agents.id, agentId))
      } catch (error) {
        errors.push(error)
      }
    }
    for (const squadId of this.squadIds) {
      try {
        await db.delete(squads).where(eq(squads.id, squadId))
      } catch (error) {
        errors.push(error)
      }
    }
    for (const agentTypeId of this.agentTypeIds) {
      try {
        await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
      } catch (error) {
        errors.push(error)
      }
    }

    for (const executionId of this.executionIds) {
      if ((await Execution.find(executionId)) !== null)
        errors.push(new Error(`Owned execution remained: ${executionId}`))
      if (concurrencyLimiter.hasSlot(executionId)) errors.push(new Error(`Owned slot remained: ${executionId}`))
      if (executionLifecycleRegistry.get(executionId))
        errors.push(new Error(`Owned lifecycle remained: ${executionId}`))
    }
    for (const agentId of this.agentIds) {
      if ((await Agent.find(agentId)) !== null) errors.push(new Error(`Owned agent remained: ${agentId}`))
      if (getSession(agentId)) errors.push(new Error(`Owned session remained: ${agentId}`))
    }
    if (errors.length > 0) throw new AggregateError(errors, `Provider pickup fixture ${this.ownerId} cleanup failed`)
    this.sessions.clear()
    this.lifecycles.clear()
    this.executionIds.clear()
    this.agentIds.clear()
    this.squadIds.clear()
    this.agentTypeIds.clear()
  }

  private async quiesceExecution(executionId: string): Promise<void> {
    const persisted = await Execution.find(executionId)
    const lifecycle = this.lifecycleLookup(executionId)
    const session = this.sessions.get(executionId)
    const active = persisted ? getSession(persisted.agentId) : undefined

    if (!lifecycle) {
      if (session || active || RUNNER_OWNERSHIP_STATUSES.some((status) => status === persisted?.status)) {
        throw new Error(`Owned execution ${executionId} has indeterminate runner ownership`)
      }
      return
    }
    if (!lifecycle.runnerStarted) {
      throw new Error(`Owned execution ${executionId} has indeterminate runner liveness`)
    }
    if (active && active.executionId !== executionId) {
      throw new Error(`Owned execution ${executionId} has a foreign active session`)
    }
    if (active && !session) {
      throw new Error(`Owned execution ${executionId} has an unobserved active session`)
    }

    await lifecycle.requestMaintenanceInterrupt()
    if (session) {
      await session.pi.abort()
      session.pi.simulateAbortEnd()
    }
    await Promise.all([lifecycle.runnerFinished, lifecycle.settled])
  }

  private restoreExemption(provider: 'zai' | 'anthropic', wasPresent: boolean): void {
    if (wasPresent) PROVIDERS_WITHOUT_AUTH.add(provider)
    else PROVIDERS_WITHOUT_AUTH.delete(provider)
  }
}

test('releases maintenance isolation when neighbor cleanup fails', async () => {
  const foreignFailure = new Error('foreign slot release failed')
  let isolationReleased = false
  let caught: unknown
  try {
    await releaseProviderSuiteResources(
      () => {
        throw foreignFailure
      },
      async () => {
        isolationReleased = true
        throw new Error('isolation secret')
      }
    )
  } catch (error) {
    caught = error
  }

  expect(isolationReleased).toBe(true)
  expect(caught).toBeInstanceOf(AggregateError)
  expect((caught as AggregateError).errors[0]).toBe(foreignFailure)
  expect((caught as Error).cause).toBe(foreignFailure)
  expect(((caught as AggregateError).errors[1] as Error).message).toBe(
    'Secondary failure: provider-maintenance-isolation-release'
  )
})

describe('concurrency-limited pickup', () => {
  let fixture: ProviderPickupFixture

  beforeEach(async () => {
    fixture = new ProviderPickupFixture()
    fixture.setup()
    await fixture.assertMaintenanceBaseline()
  })

  afterEach(async () => fixture.cleanup())

  test('keeps the invariant primary when diagnostics fail', async () => {
    const primary = new Error('PRIMARY_PICKUP_INVARIANT')
    const diagnostic = new Error('DIAGNOSTIC_SECRET_postgres://live')
    fixture.setDiagnosticDeps({ readMaintenance: async () => Promise.reject(diagnostic) })

    let caught: unknown
    try {
      await fixture.assertInvariant({ id: `candidate-${fixture.ownerId}` } as Execution, () => {
        throw primary
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors[0]).toBe(primary)
    expect((caught as Error).cause).toBe(primary)
    expect(((caught as AggregateError).errors[1] as Error).message).toBe(
      'Secondary failure: provider-invariant-diagnostics'
    )
    const renderedSecondaries = (caught as AggregateError).errors
      .slice(1)
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join('\n')
    expect(String(caught)).not.toContain('DIAGNOSTIC_SECRET')
    expect(renderedSecondaries).not.toContain('DIAGNOSTIC_SECRET')
  })

  test('does not delete or settle an owned execution while its runner is live', async () => {
    const gate = fixture.deferSessionPublication()
    const execution = await fixture.queue(await fixture.createSquadAgent('zai:glm-5.2'))

    await fixture.expectPickup(execution, 'started')
    await gate.entered
    const lifecycle = executionLifecycleRegistry.get(execution.id)!
    expect(lifecycle.runnerStarted).toBe(true)

    const interruptHeld = Promise.withResolvers<void>()
    const allowInterrupt = Promise.withResolvers<void>()
    lifecycle.attachQuiesce(async () => {
      interruptHeld.resolve()
      await allowInterrupt.promise
      // Settlement may precede runner exit; it is not a liveness proof.
      lifecycle.settle()
    })

    const cleanup = fixture.cleanup()
    await interruptHeld.promise
    expect(await Execution.find(execution.id)).not.toBeNull()
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(true)
    expect(executionLifecycleRegistry.get(execution.id)).toBe(lifecycle)

    allowInterrupt.resolve()
    await Bun.sleep(10)
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(true)
    expect(executionLifecycleRegistry.get(execution.id)).toBe(lifecycle)

    const publishedSession = fixture.publishedSession(execution.id)
    gate.release()
    const session = await publishedSession
    await cleanup
    expect(session.pi.promptCalls).toHaveLength(0)
    expect(await Execution.find(execution.id)).toBeNull()
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(false)
    expect(executionLifecycleRegistry.get(execution.id)).toBeUndefined()
  })

  test('retains owned resources when lifecycle visibility is indeterminate', async () => {
    const gate = fixture.deferSessionPublication()
    const execution = await fixture.queue(await fixture.createSquadAgent('zai:glm-5.2'))
    await fixture.expectPickup(execution, 'started')
    await gate.entered
    expect(fixture.sessions.has(execution.id)).toBe(false)
    expect(getSession(execution.agentId)).toBeUndefined()

    fixture.setLifecycleLookup(() => undefined)
    await expect(fixture.cleanup()).rejects.toThrow('indeterminate runner ownership')
    expect(await Execution.find(execution.id)).not.toBeNull()
    expect(await Agent.find(execution.agentId)).not.toBeNull()
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(false)
    fixture.assertGlobalsRestored()

    fixture.setLifecycleLookup((executionId) => executionLifecycleRegistry.get(executionId))
    const cleanup = fixture.cleanup()
    gate.release()
    await cleanup
  })

  test('keeps quiescence primary when global restoration also fails', async () => {
    const gate = fixture.deferSessionPublication()
    const execution = await fixture.queue(await fixture.createSquadAgent('zai:glm-5.2'))
    await fixture.expectPickup(execution, 'started')
    await gate.entered
    fixture.setLifecycleLookup(() => undefined)
    const restorationFailure = new Error('spy restoration failed')
    fixture.setCreateSessionSpyRestorer(() => {
      throw restorationFailure
    })

    let caught: unknown
    try {
      await fixture.cleanup()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect(((caught as AggregateError).errors[0] as Error).message).toContain('indeterminate runner ownership')
    expect(((caught as AggregateError).errors[1] as Error).message).toBe(
      'Secondary failure: provider-session-spy-restoration'
    )
    expect((caught as Error).cause).toBe((caught as AggregateError).errors[0])
    expect(await Execution.find(execution.id)).not.toBeNull()

    fixture.setCreateSessionSpyRestorer(undefined)
    fixture.setLifecycleLookup((executionId) => executionLifecycleRegistry.get(executionId))
    const cleanup = fixture.cleanup()
    gate.release()
    await cleanup
  })

  test('keeps execution identities in multiple quiescence failures', async () => {
    const first = await fixture.queue(await fixture.createSquadAgent('zai:glm-5.2'))
    const second = await fixture.queue(await fixture.createSquadAgent('zai:glm-5.2'))
    await db.update(executions).set({ status: 'waiting-maintenance' }).where(eq(executions.id, first.id))
    await db.update(executions).set({ status: 'waiting-sandbox' }).where(eq(executions.id, second.id))

    let caught: unknown
    try {
      await fixture.cleanup()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect(((caught as AggregateError).errors[1] as Error).message).toBe(
      `Secondary failure: provider-runner-quiescence-${second.id}`
    )
    expect(await Execution.find(first.id)).not.toBeNull()
    expect(await Execution.find(second.id)).not.toBeNull()
    fixture.assertGlobalsRestored()

    await db.update(executions).set({ status: 'completed' }).where(eq(executions.id, first.id))
    await db.update(executions).set({ status: 'completed' }).where(eq(executions.id, second.id))
    await fixture.cleanup()
  })

  test.each(['waiting-sandbox', 'waiting-maintenance'] as const)(
    'fails closed for missing lifecycle in %s',
    async (status) => {
      const execution = await fixture.queue(await fixture.createSquadAgent('zai:glm-5.2'))
      await db.update(executions).set({ status }).where(eq(executions.id, execution.id))

      await expect(fixture.cleanup()).rejects.toThrow('indeterminate runner ownership')
      expect(await Execution.find(execution.id)).not.toBeNull()

      await db.update(executions).set({ status: 'completed' }).where(eq(executions.id, execution.id))
      await fixture.cleanup()
    }
  )

  test('holds the N+1th execution when the provider limit is reached', async () => {
    const firstExecution = await fixture.queue(await fixture.createSquadAgent('zai:glm-5.2'))
    const secondExecution = await fixture.queue(await fixture.createSquadAgent('zai:glm-5.2'))

    await fixture.expectPickup(firstExecution, 'started')
    await fixture.waitForPrompt(firstExecution.id)
    await fixture.expectPickup(secondExecution, 'no-capacity')
    await fixture.assertInvariant(secondExecution, async () => {
      expect(concurrencyLimiter.hasSlot(firstExecution.id)).toBe(true)
      expect(concurrencyLimiter.hasSlot(secondExecution.id)).toBe(false)
      expect((await Execution.mustFind(secondExecution.id)).status).toBe('queued')
    })
  })

  test('starts the next queued execution after a running execution completes', async () => {
    const firstExecution = await fixture.queue(await fixture.createSquadAgent('zai:glm-5.2'))
    const secondExecution = await fixture.queue(await fixture.createSquadAgent('zai:glm-5.2'))

    await fixture.expectPickup(firstExecution, 'started')
    await fixture.waitForPrompt(firstExecution.id)
    await fixture.expectPickup(secondExecution, 'no-capacity')
    await fixture.finish(firstExecution.id, 'first complete')
    await fixture.assertInvariant(firstExecution, async () => {
      expect((await Execution.mustFind(firstExecution.id)).status).toBe('completed')
      expect(concurrencyLimiter.hasSlot(firstExecution.id)).toBe(false)
    })

    await fixture.expectPickup(secondExecution, 'started')
    await fixture.waitForPrompt(secondExecution.id)
    await fixture.assertInvariant(secondExecution, async () => {
      expect(concurrencyLimiter.hasSlot(secondExecution.id)).toBe(true)
      expect((await Execution.mustFind(secondExecution.id)).status).toBe('running')
    })
  })

  test('does not let a saturated provider block an unlimited provider', async () => {
    const firstExecution = await fixture.queue(await fixture.createSquadAgent('zai:glm-5.2'))
    const secondExecution = await fixture.queue(await fixture.createSquadAgent('zai:glm-5.2'))
    const anthropicExecution = await fixture.queue(await fixture.createSquadAgent('anthropic:claude-sonnet-4-5'))

    await fixture.expectPickup(firstExecution, 'started')
    await fixture.waitForPrompt(firstExecution.id)
    const outcomes: Array<[string, PickupResult]> = []
    const count = await sweepQueuedExecutionCandidates([secondExecution, anthropicExecution], 2, async (candidate) => {
      const result = await fixture.pickup(candidate)
      outcomes.push([candidate.id, result])
      return result
    })

    await fixture.assertInvariant(secondExecution, () => {
      expect(outcomes).toEqual([
        [secondExecution.id, 'no-capacity'],
        [anthropicExecution.id, 'started'],
      ])
      expect(count).toBe(1)
    })
    await fixture.waitForPrompt(anthropicExecution.id)
    await fixture.assertInvariant(secondExecution, async () => {
      expect((await Execution.mustFind(secondExecution.id)).status).toBe('queued')
      expect((await Execution.mustFind(anthropicExecution.id)).status).toBe('running')
      expect(concurrencyLimiter.hasSlot(firstExecution.id)).toBe(true)
      expect(concurrencyLimiter.hasSlot(secondExecution.id)).toBe(false)
      expect(concurrencyLimiter.hasSlot(anthropicExecution.id)).toBe(true)
    })
  })
})
