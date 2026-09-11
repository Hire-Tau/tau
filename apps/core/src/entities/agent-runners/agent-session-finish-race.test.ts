import { afterAll as maintenanceAfterAll, beforeAll as maintenanceBeforeAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
maintenanceBeforeAll(async () => (releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()))
maintenanceAfterAll(() => releaseMaintenanceIsolation?.())

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import {
  agents,
  agentTypes,
  executionAdmissionReservations,
  executions,
  instanceMaintenanceState,
  squads,
} from '../../db/schema'
import { AgentType } from '../AgentType'
import { Agent } from '../Agent'
import { Execution } from '../Execution'
import { SquadWorkerRunner } from './squad-worker-runner'
import {
  AdmissionLease,
  AdmissionLeaseLostError,
  AdmissionReservationStore,
  replaceAdmissionReservationForPickup,
  settleExactAdmissionLease,
} from '../../services/maintenance/admission-reservation'
import { classifySetupFailure } from '../../services/execution/failure-classification'
import { admissionProcessIncarnation } from '../../services/maintenance/process-liveness'
import { MaintenanceAdmissionPaused } from '../../services/maintenance/admission-evidence'
import { MaintenanceStore } from '../../services/maintenance/store'

/**
 * The agent-session phase-finish / self-settlement race: when the runner's own
 * terminal teardown settles its exact admission lease while a phase finish is
 * still in flight, the finish CAS misses but the row is TERMINAL for this
 * exact lease — our own bookkeeping catching up, not a platform refusal. It
 * must not throw (and therefore must never classify the execution as
 * platform_pre_tool_refusal or send the owner a platform-failure notice). A
 * genuine takeover (foreign owner on the row) still throws.
 */
describe('agent-session phase finish vs self-settled lease race', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let squadId: string
  let agent: Agent
  let execution: Execution
  const store = new AdmissionReservationStore('runner:test', admissionProcessIncarnation)

  beforeEach(async () => {
    testPrefix = `finishrace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    await AgentType.create({
      id: testAgentTypeId,
      model: 'zai:glm-5.2',
      name: 'Finish Race Worker',
      systemPrompt: 'You are a test agent.',
    })
    const [squad] = await db
      .insert(squads)
      .values({ name: `${testPrefix} Squad`, purpose: 'phase finish race tests' })
      .returning()
    squadId = squad.id
    agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
    execution = await agent.queueExecution({ message: 'finish race' })
    await execution.start()
    await db.insert(instanceMaintenanceState).values({ id: 'global' }).onConflictDoNothing()
  })

  afterEach(async () => {
    await db.delete(executionAdmissionReservations).where(eq(executionAdmissionReservations.executionId, execution.id))
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    await db.delete(instanceMaintenanceState)
  })

  /** Bind the execution's runner claim to a live lease, as pickup does, and advance it to the agent-session precondition. */
  async function seedLease(): Promise<AdmissionLease> {
    const fresh = await Execution.mustFind(execution.id)
    const [maintenance] = await db
      .select({
        generation: instanceMaintenanceState.generation,
        holderRevision: instanceMaintenanceState.holderRevision,
      })
      .from(instanceMaintenanceState)
      .where(eq(instanceMaintenanceState.id, 'global'))
    const lease = await db.transaction((tx) =>
      replaceAdmissionReservationForPickup(tx, {
        executionId: fresh.id,
        agentId: agent.id,
        token: fresh.runnerClaimToken!,
        ownerId: 'runner:test',
        ownerIncarnation: admissionProcessIncarnation,
        generation: maintenance!.generation,
        holderRevision: maintenance!.holderRevision,
      })
    )
    // The real flow reaches agent-session after session-create (successState
    // 'running'); set that precondition directly.
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'running' })
      .where(eq(executionAdmissionReservations.executionId, fresh.id))
    return lease
  }

  async function runnerWithClaim(): Promise<{ runner: SquadWorkerRunner; lease: AdmissionLease }> {
    const { createRunner } = await import('./index')
    const fresh = await Execution.mustFind(execution.id)
    const freshAgent = await Agent.mustFind(agent.id)
    const runner = (await createRunner(freshAgent, fresh)) as SquadWorkerRunner
    const lease = await seedLease()
    const withStore = runner as unknown as {
      admissionStore: AdmissionReservationStore | null
      admissionLease: AdmissionLease | null
    }
    withStore.admissionStore = store
    withStore.admissionLease = lease
    return { runner, lease }
  }

  test('a finish that lost the race to its own settlement does not throw, classify, or fail the execution', async () => {
    const { runner } = await runnerWithClaim()
    const phase = (runner as unknown as { withAdmissionWritePhase: <T>(...args: unknown[]) => Promise<T> })
      .withAdmissionWritePhase

    const result = await phase.call(
      runner,
      'agent-session',
      `execution:${execution.id}:agent-session`,
      async () => {
        // The runner's own terminal teardown settles the exact lease while the
        // phase is open — the finish CAS below will miss.
        await db.transaction(async (tx) => settleExactAdmissionLease(tx, await currentLease(), 'released'))
        return 'turn-completed'
      },
      'running'
    )

    expect(result).toBe('turn-completed')
    // Nothing failed: the execution is untouched and unclassified, so no
    // platform-failure notice can fire for this bookkeeping artifact.
    const [row] = await db.select().from(executions).where(eq(executions.id, execution.id))
    expect(row.status).toBe('running')
    expect(row.failureClass).toBeNull()
  })

  test('a finish that lost the lease to a genuine takeover still throws and classifies as a platform refusal', async () => {
    const { runner } = await runnerWithClaim()
    const phase = (runner as unknown as { withAdmissionWritePhase: <T>(...args: unknown[]) => Promise<T> })
      .withAdmissionWritePhase

    const promise = phase.call(
      runner,
      'agent-session',
      `execution:${execution.id}:agent-session`,
      async () => {
        // A foreign owner takes the reservation over mid-phase.
        await db
          .update(executionAdmissionReservations)
          .set({ token: crypto.randomUUID(), claimEpoch: 1n + 1n })
          .where(eq(executionAdmissionReservations.executionId, execution.id))
        return 'turn-completed'
      },
      'running'
    )

    await expect(promise).rejects.toBeInstanceOf(AdmissionLeaseLostError)
    const error = (await promise.catch((reason: unknown) => reason)) as AdmissionLeaseLostError
    expect(error.refusal).toBe('finish-refused')
    // A genuine takeover IS a platform-level refusal and reaches the owner.
    expect(classifySetupFailure(error)).toEqual({
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_lease_lost',
    })
  })

  test('the settlement finish order also treats an exact-terminal miss as self-settled success', async () => {
    const { runner } = await runnerWithClaim()
    const phase = (runner as unknown as { withAdmissionWritePhase: <T>(...args: unknown[]) => Promise<T> })
      .withAdmissionWritePhase

    // The settlement variant publishes its blocking state BEFORE the operation,
    // so inject the race at the finish boundary itself: the terminal write
    // settles the exact lease immediately before the finish CAS runs.
    const originalFinish = AdmissionReservationStore.prototype.finishWritePhase
    const finishSpy = spyOn(AdmissionReservationStore.prototype, 'finishWritePhase').mockImplementationOnce(
      async function (this: AdmissionReservationStore, ...finishArgs: Parameters<typeof originalFinish>) {
        await db.transaction(async (tx) => settleExactAdmissionLease(tx, finishArgs[0], 'released'))
        return originalFinish.apply(this, finishArgs)
      }
    )

    try {
      const result = await phase.call(
        runner,
        'settlement',
        `execution:${execution.id}:settlement`,
        async () => 'settled-ok',
        'settling'
      )

      expect(result).toBe('settled-ok')
      expect(finishSpy).toHaveBeenCalled()
    } finally {
      finishSpy.mockRestore()
    }
    const [row] = await db.select().from(executions).where(eq(executions.id, execution.id))
    expect(row.status).toBe('running')
    expect(row.failureClass).toBeNull()
  })

  test('a closed fence wins over the terminal-lease check: the finish still pauses, never silently succeeds', async () => {
    const { runner } = await runnerWithClaim()
    const phase = (runner as unknown as { withAdmissionWritePhase: <T>(...args: unknown[]) => Promise<T> })
      .withAdmissionWritePhase

    try {
      const promise = phase.call(
        runner,
        'agent-session',
        `execution:${execution.id}:agent-session`,
        async () => {
          // Both facts land together: our own settlement settled the exact
          // lease AND the maintenance fence closed. The fence check runs
          // FIRST, so this must surface as a pause — the terminal-lease
          // idempotence can never mask an acquired pause.
          await db.transaction(async (tx) => settleExactAdmissionLease(tx, await currentLease(), 'released'))
          await new MaintenanceStore().setAdminHold({ active: true, actor: 'test' })
          return 'turn-completed'
        },
        'running'
      )

      await expect(promise).rejects.toBeInstanceOf(MaintenanceAdmissionPaused)
    } finally {
      await new MaintenanceStore().setAdminHold({ active: false, actor: 'test' }).catch(() => {})
    }
  })

  /** The lease as currently recorded on the reservation row. */
  async function currentLease(): Promise<AdmissionLease> {
    const [row] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    return {
      executionId: row.executionId,
      token: row.token!,
      claimEpoch: row.claimEpoch!,
      generation: row.admittedGeneration!,
      holderRevision: row.admittedHolderRevision!,
      ownerId: row.ownerId!,
      ownerIncarnation: row.ownerIncarnation!,
    }
  }
})
