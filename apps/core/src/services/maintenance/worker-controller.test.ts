import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'
import { eq } from 'drizzle-orm'
import {
  agents,
  db,
  executionAdmissionReservations,
  executions,
  messages,
  instanceMaintenanceAudit,
  instanceMaintenanceState,
} from '../../db'
import { Execution } from '../../entities/Execution'
import { MaintenanceStore } from './store'
import { MaintenanceWorkerController } from './worker-controller'
import { AdmissionReservationStore } from './admission-reservation'
import {
  admissionProcessIncarnation,
  startAdmissionProcessLiveness,
  stopAdmissionProcessLiveness,
} from './process-liveness'
import { executionLifecycleRegistry } from '../execution/lifecycle-registry'
import { registerSession, removeSession } from '../execution/session-state'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
beforeAll(async () => {
  releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()
})
afterAll(() => releaseMaintenanceIsolation?.())

const store = new MaintenanceStore()
const controller = new MaintenanceWorkerController(store)

beforeEach(async () => {
  // This file owns the maintenance fixture lock, so clear admission blockers
  // leaked by execution suites before asserting controller quiescence.
  for (const lifecycle of executionLifecycleRegistry.list()) {
    lifecycle.settle()
    lifecycle.markRunnerFinished()
  }
  await db.delete(executionAdmissionReservations)
  await db.delete(instanceMaintenanceAudit)
  await db.delete(instanceMaintenanceState)
  await store.initialize()
})
afterEach(async () => {
  await stopAdmissionProcessLiveness()
  await db.delete(executions)
  await db.delete(agents)
  await db.delete(instanceMaintenanceAudit)
  await db.delete(instanceMaintenanceState)
})

describe('MaintenanceWorkerController', () => {
  async function runningExecution() {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker', status: 'active' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    return { agent, execution }
  }

  it('queued-admission recovery requires queued execution status', async () => {
    const { agent, execution } = await runningExecution()
    await db.insert(executionAdmissionReservations).values({
      executionId: execution.id,
      agentId: agent.id,
      state: 'running',
      phase: 'none',
      token: crypto.randomUUID(),
      claimEpoch: 101n,
      ownerId: 'dead-nonqueued-owner',
      ownerIncarnation: crypto.randomUUID(),
      admittedGeneration: 103,
      admittedHolderRevision: 107n,
      leaseExpiresAt: new Date(0),
      lastHeartbeatAt: new Date(0),
    })
    const [executionBefore] = await db.select().from(executions).where(eq(executions.id, execution.id))
    const [reservationBefore] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    await controller.reconcileNow()

    const [executionAfter] = await db.select().from(executions).where(eq(executions.id, execution.id))
    const [reservationAfter] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(executionAfter).toEqual(executionBefore)
    expect(reservationAfter).toEqual(reservationBefore)
  })

  it('queued-admission recovery preserves an agentId-mismatched reservation', async () => {
    const [executionAgent] = await db.insert(agents).values({ agentTypeId: 'worker', status: 'active' }).returning()
    const [reservationAgent] = await db.insert(agents).values({ agentTypeId: 'worker', status: 'active' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: executionAgent.id, status: 'queued' }).returning()
    await db.insert(executionAdmissionReservations).values({
      executionId: execution.id,
      agentId: reservationAgent.id,
      state: 'running',
      phase: 'none',
      token: crypto.randomUUID(),
      claimEpoch: 109n,
      ownerId: 'dead-mismatched-owner',
      ownerIncarnation: crypto.randomUUID(),
      admittedGeneration: 113,
      admittedHolderRevision: 127n,
      leaseExpiresAt: new Date(0),
      lastHeartbeatAt: new Date(0),
    })
    const [executionBefore] = await db.select().from(executions).where(eq(executions.id, execution.id))
    const [reservationBefore] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    await controller.reconcileNow()

    const [executionAfter] = await db.select().from(executions).where(eq(executions.id, execution.id))
    const [reservationAfter] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(executionAfter).toEqual(executionBefore)
    expect(reservationAfter).toEqual(reservationBefore)
  })

  it('queued-admission recovery preserves terminal reservations', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker', status: 'active' }).returning()
    for (const state of ['released', 'revoked'] as const) {
      const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'queued' }).returning()
      await db.insert(executionAdmissionReservations).values({
        executionId: execution.id,
        agentId: agent.id,
        state,
        phase: 'none',
        token: crypto.randomUUID(),
        claimEpoch: 131n,
        ownerId: `terminal-${state}`,
        ownerIncarnation: crypto.randomUUID(),
        admittedGeneration: 137,
        admittedHolderRevision: 139n,
        leaseExpiresAt: new Date(0),
        lastHeartbeatAt: new Date(0),
      })
      const [before] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))

      await controller.reconcileNow()

      const [after] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      expect(after).toEqual(before)
    }
  })

  it('production reconciliation keeps an expired Pi-session effect unknown while its owner lock is live', async () => {
    const { execution } = await runningExecution()
    const reservations = new AdmissionReservationStore('pickup', crypto.randomUUID())
    const provisional = await reservations.createProvisional(execution.id)
    await db
      .update(executions)
      .set({ runnerClaimToken: provisional.token, runnerClaimGeneration: provisional.generation })
      .where(eq(executions.id, execution.id))
    await startAdmissionProcessLiveness()
    const runner = new AdmissionReservationStore('runner', admissionProcessIncarnation)
    const lease = await runner.claimProvisionalLease(execution.id, provisional.token, provisional.generation)
    expect(lease?.token).toBe(provisional.token)
    await runner.beginWritePhase(lease!, 'session-create', `execution:${execution.id}:pi-session`)
    await db
      .update(executionAdmissionReservations)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    await controller.reconcileNow()

    const [recoveredExecution] = await db.select().from(executions).where(eq(executions.id, execution.id))
    const [recoveredReservation] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(recoveredExecution.status).toBe('running')
    expect(recoveredExecution.runnerClaimToken).toBe(provisional.token)
    expect(recoveredReservation).toMatchObject({
      state: 'unknown',
      phase: 'session-create',
      recoveryOwnerId: null,
    })
    await stopAdmissionProcessLiveness()
  })

  it('production reconciliation recovers Pi-session only after the old process lock is provably absent', async () => {
    const { execution } = await runningExecution()
    const pickup = new AdmissionReservationStore('pickup', crypto.randomUUID())
    const provisional = await pickup.createProvisional(execution.id)
    await db
      .update(executions)
      .set({ runnerClaimToken: provisional.token, runnerClaimGeneration: provisional.generation })
      .where(eq(executions.id, execution.id))
    const runner = new AdmissionReservationStore('runner', crypto.randomUUID())
    const lease = await runner.claimProvisionalLease(execution.id, provisional.token, provisional.generation)
    const phase = await runner.beginWritePhase(lease!, 'session-create', `execution:${execution.id}:pi-session`)
    await db
      .update(executionAdmissionReservations)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    await controller.reconcileNow()

    const [recovered] = await db.select().from(executions).where(eq(executions.id, execution.id))
    expect(recovered.status).toBe('queued')
    expect(await runner.finishWritePhase(lease!, phase!, 'running')).toBe(false)
  })

  it('production reconciliation safely replays every idempotent unknown external phase and excludes its neighbor', async () => {
    const phases = [
      'sandbox-drift-recreate',
      'sandbox-ensure',
      'toolchain-reconcile',
      'workspace-watch-configure',
      'local-deployment-restart',
    ] as const
    const created: string[] = []
    for (const phase of phases) {
      const { execution } = await runningExecution()
      created.push(execution.id)
      const pickup = new AdmissionReservationStore('pickup', crypto.randomUUID())
      const provisional = await pickup.createProvisional(execution.id)
      await db
        .update(executions)
        .set({ runnerClaimToken: provisional.token, runnerClaimGeneration: provisional.generation })
        .where(eq(executions.id, execution.id))
      const runner = new AdmissionReservationStore('runner', crypto.randomUUID())
      const lease = await runner.claimProvisionalLease(execution.id, provisional.token, provisional.generation)
      await runner.beginWritePhase(lease!, phase, `sandbox:${execution.id}`)
      await db
        .update(executionAdmissionReservations)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(executionAdmissionReservations.executionId, execution.id))
    }
    const { execution: neighbor } = await runningExecution()

    await controller.reconcileNow()

    const recovered = await db.select().from(executions)
    for (const executionId of created) {
      expect(recovered.find((row) => row.id === executionId)?.status).toBe('queued')
    }
    expect(recovered.find((row) => row.id === neighbor.id)?.status).toBe('running')
  })

  it('recovers dead-owner agent-session, settlement, and sandbox-recovery without touching a neighbor', async () => {
    const phases = ['agent-session', 'settlement', 'sandbox-recovery'] as const
    const expected = new Map<string, 'queued' | 'completed'>()
    for (const phase of phases) {
      const { agent, execution } = await runningExecution()
      const pickup = new AdmissionReservationStore('pickup', crypto.randomUUID())
      const provisional = await pickup.createProvisional(execution.id)
      await db
        .update(executions)
        .set({ runnerClaimToken: provisional.token, runnerClaimGeneration: provisional.generation })
        .where(eq(executions.id, execution.id))
      const runner = new AdmissionReservationStore('runner', crypto.randomUUID())
      const lease = await runner.claimProvisionalLease(execution.id, provisional.token, provisional.generation)
      if (phase !== 'sandbox-recovery') {
        const sessionCreate = await runner.beginWritePhase(lease!, 'session-create', `execution:${execution.id}`)
        await runner.finishWritePhase(lease!, sessionCreate!, 'running')
      }
      const opened = await runner.beginWritePhase(lease!, phase, `execution:${execution.id}:${phase}`)
      if (phase === 'settlement') {
        await runner.finishWritePhase(lease!, opened!, 'settling')
        await db.insert(messages).values({
          agentId: agent.id,
          role: 'assistant',
          content: 'durably settled',
          metadata: { executionId: execution.id },
        })
        expected.set(execution.id, 'completed')
      } else {
        expected.set(execution.id, 'queued')
      }
      await db
        .update(executionAdmissionReservations)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(executionAdmissionReservations.executionId, execution.id))
    }
    const { execution: neighbor } = await runningExecution()

    await controller.reconcileNow()

    const rows = await db.select().from(executions)
    for (const [executionId, status] of expected) {
      expect(rows.find((row) => row.id === executionId)?.status).toBe(status)
    }
    expect(rows.find((row) => row.id === neighbor.id)?.status).toBe('running')
  })

  it('requeues recovered running rows before acknowledging quiescence', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker', status: 'active' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const paused = await store.setAdminHold({ active: true, actor: 'test' })

    await controller.reconcileNow()

    const [fresh] = await db.select().from(executions).where(eq(executions.id, execution.id))
    expect(fresh.status).toBe('waiting-maintenance')
    expect(fresh.maintenanceGeneration).toBe(paused.generation)
    const snapshot = await store.read()
    expect(snapshot.quiescedGeneration).toBe(paused.generation)
    expect(snapshot.phase).toBe('paused')
  })

  it('resumes durably parked rows after maintenance releases', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker', status: 'active' }).returning()
    const paused = await store.setAdminHold({ active: true, actor: 'test' })
    const [execution] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'waiting-maintenance',
        maintenanceGeneration: paused.generation,
        maintenanceQueuedAt: new Date(),
      })
      .returning()
    await store.setAdminHold({ active: false, actor: 'resume' })

    await controller.reconcileNow()

    const [fresh] = await db.select().from(executions).where(eq(executions.id, execution.id))
    expect(fresh.status).toBe('queued')
    expect(fresh.maintenanceGeneration).toBeNull()
    expect(fresh.maintenanceQueuedAt).toBeNull()
  })

  it('transactionally refuses requeue when release commits between advisory check and update', async () => {
    const { execution } = await runningExecution()
    const paused = await store.setAdminHold({ active: true, actor: 'test' })
    let releaseLocked!: () => void
    const locked = new Promise<void>((resolve) => (releaseLocked = resolve))
    let commitRelease!: () => void
    const commit = new Promise<void>((resolve) => (commitRelease = resolve))
    const release = db.transaction(async (tx) => {
      await tx
        .update(instanceMaintenanceState)
        .set({ adminHold: false })
        .where(eq(instanceMaintenanceState.id, 'global'))
      releaseLocked()
      await commit
    })
    await locked

    const entity = await Execution.mustFind(execution.id)
    const requeue = entity.requeueIfRunningForMaintenance((tx) =>
      store.isGenerationEffectiveLocked(tx, paused.generation)
    )
    commitRelease()
    await release

    expect(await requeue).toBe(false)
    expect((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]?.status).toBe('running')
  })

  it('does not let a released generation drain newly admitted work', async () => {
    const { execution } = await runningExecution()
    await store.setAdminHold({ active: true, actor: 'test' })
    const originalRefresh = store.refresh.bind(store)
    let refreshes = 0
    store.refresh = async () => {
      const state = await originalRefresh()
      if (++refreshes === 2) return store.setAdminHold({ active: false, actor: 'resume' })
      return state
    }
    try {
      await new MaintenanceWorkerController(store, 1).reconcileNow()
    } finally {
      store.refresh = originalRefresh
    }
    const [fresh] = await db.select().from(executions).where(eq(executions.id, execution.id))
    expect(fresh.status).toBe('running')
    expect((await store.read()).effective).toBe(false)
  })

  it('retries after abort rejection instead of memoizing a permanent wedge', async () => {
    const { agent, execution } = await runningExecution()
    await store.setAdminHold({ active: true, actor: 'test' })
    const lifecycle = executionLifecycleRegistry.registerProvisional(execution.id, agent.id, 0)
    lifecycle.markRunnerStarted()
    let aborts = 0
    const pi = {
      isBashRunning: false,
      abortBash() {},
      async abort() {
        if (++aborts === 1) throw new Error('transient abort failure')
      },
    }
    registerSession(agent.id, { agentId: agent.id, executionId: execution.id, session: { pi } } as never)
    lifecycle.attachFallbackSettlement(async () => {
      removeSession(agent.id)
      lifecycle.settle()
      lifecycle.markRunnerFinished()
    })
    const retrying = new MaintenanceWorkerController(store, 1)

    await retrying.reconcileNow()
    expect((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]?.status).toBe('running')
    await retrying.reconcileNow()
    expect((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]?.status).toBe(
      'waiting-maintenance'
    )
    expect(aborts).toBe(2)
    removeSession(agent.id)
  })

  it('retries an abort call that never resolves', async () => {
    const { agent, execution } = await runningExecution()
    await store.setAdminHold({ active: true, actor: 'test' })
    const lifecycle = executionLifecycleRegistry.registerProvisional(execution.id, agent.id, 0)
    lifecycle.markRunnerStarted()
    let aborts = 0
    const pi = {
      isBashRunning: false,
      abortBash() {},
      abort() {
        if (++aborts === 1) return new Promise<void>(() => {})
        return Promise.resolve()
      },
    }
    registerSession(agent.id, { agentId: agent.id, executionId: execution.id, session: { pi } } as never)
    lifecycle.attachFallbackSettlement(async () => {
      removeSession(agent.id)
      lifecycle.settle()
      lifecycle.markRunnerFinished()
    })
    const retrying = new MaintenanceWorkerController(store, 1)

    await retrying.reconcileNow()
    await retrying.reconcileNow()

    expect((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]?.status).toBe(
      'waiting-maintenance'
    )
    expect(aborts).toBe(2)
    removeSession(agent.id)
  })

  it('does not requeue while slow runner setup remains alive after persistence fallback', async () => {
    const { agent, execution } = await runningExecution()
    const paused = await store.setAdminHold({ active: true, actor: 'test' })
    const lifecycle = executionLifecycleRegistry.registerProvisional(execution.id, agent.id, 0)
    lifecycle.markRunnerStarted()
    const pi = { isBashRunning: false, abortBash() {}, async abort() {} }
    registerSession(agent.id, { agentId: agent.id, executionId: execution.id, session: { pi } } as never)
    lifecycle.attachFallbackSettlement(async () => {
      removeSession(agent.id)
      lifecycle.settle()
      // createSession/runner setup deliberately remains alive.
    })
    const controller = new MaintenanceWorkerController(store, 2)

    await controller.reconcileNow()

    expect((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]?.status).toBe('running')
    expect((await store.read()).quiescedGeneration).toBeLessThan(paused.generation)
    expect(executionLifecycleRegistry.get(execution.id)).toBe(lifecycle)

    lifecycle.markRunnerFinished()
    await controller.reconcileNow()
    expect((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]?.status).toBe(
      'waiting-maintenance'
    )
  })

  it('uses bounded fallback when an aborted session never emits settlement', async () => {
    const { agent, execution } = await runningExecution()
    await store.setAdminHold({ active: true, actor: 'test' })
    const lifecycle = executionLifecycleRegistry.registerProvisional(execution.id, agent.id, 0)
    lifecycle.markRunnerStarted()
    const pi = { isBashRunning: false, abortBash() {}, async abort() {} }
    registerSession(agent.id, { agentId: agent.id, executionId: execution.id, session: { pi } } as never)
    const order: string[] = []
    let fallbackStarted!: () => void
    const started = new Promise<void>((resolve) => (fallbackStarted = resolve))
    let persistenceSettled!: () => void
    const persistence = new Promise<void>((resolve) => (persistenceSettled = resolve))
    lifecycle.attachFallbackSettlement(async () => {
      order.push('mark-active-tool-aborted')
      fallbackStarted()
      await persistence
      order.push('persistence-settled')
      removeSession(agent.id)
      lifecycle.settle()
      lifecycle.markRunnerFinished()
    })

    const reconciliation = new MaintenanceWorkerController(store, 100).reconcileNow()
    await started
    expect((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]?.status).toBe('running')
    persistenceSettled()
    await reconciliation

    expect((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]?.status).toBe(
      'waiting-maintenance'
    )
    expect(order).toEqual(['mark-active-tool-aborted', 'persistence-settled'])
    expect(executionLifecycleRegistry.get(execution.id)).toBeUndefined()
  })
})
