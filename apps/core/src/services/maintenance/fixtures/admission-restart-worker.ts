import { eq } from 'drizzle-orm'
import { db, executionAdmissionReservations, executions, messages } from '../../../db'
import { Execution } from '../../../entities/Execution'
import { SquadWorkerRunner } from '../../../entities/agent-runners/squad-worker-runner'
import { MockAgentSession } from '../../execution/test-helpers'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { attemptPickup } from '../../execution/pickup'
import { executionLifecycleRegistry } from '../../execution/lifecycle-registry'
import { isSessionActive } from '../../execution/session-state'
import { recoverInterruptedExecutionsForStartup } from '../../execution/startup-recovery'
import { PROVIDERS_WITHOUT_AUTH } from '../../model-selection/select-model'
import { maintenanceStore } from '..'
import { AdmissionReservationStore } from '../admission-reservation'
import {
  admissionProcessIncarnation,
  startAdmissionProcessLiveness,
  stopAdmissionProcessLiveness,
} from '../process-liveness'

const [mode, executionId, target = 'provisional'] = process.argv.slice(2)
if (!executionId || (mode !== 'owner' && mode !== 'successor')) throw new Error('Expected owner|successor executionId')

await maintenanceStore.initialize()
await startAdmissionProcessLiveness(() => process.exit(91))
PROVIDERS_WITHOUT_AUTH.add('zai')

if (mode === 'owner') {
  let resolveBarrier!: () => void
  let rejectBarrier!: (error: unknown) => void
  const barrierObserved = new Promise<void>((resolve, reject) => {
    resolveBarrier = resolve
    rejectBarrier = reject
  })
  const unsubscribeOwnerFailure = eventEmitter.on('execution.failed', (payload) => {
    if (payload.executionId !== executionId) return
    unsubscribeOwnerFailure()
    rejectBarrier(new Error(`Owner execution failed before durable ${target} barrier`))
  })
  const barrier = async (expectedState: string, expectedPhase: string) => {
    try {
      const [reservation] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, executionId))
      const [execution] = await db.select().from(executions).where(eq(executions.id, executionId))
      if (!reservation || !execution) throw new Error(`Missing durable restart barrier row for ${executionId}`)
      if (execution.status !== 'running')
        throw new Error(`Restart barrier execution is ${execution.status}, not running`)
      if (reservation.executionId !== executionId) throw new Error('Restart barrier execution identity mismatch')
      if (reservation.state !== expectedState || reservation.phase !== expectedPhase) {
        throw new Error(
          `Restart barrier mismatch: expected ${expectedState}/${expectedPhase}, got ${reservation.state}/${reservation.phase}`
        )
      }
      if (reservation.ownerIncarnation !== admissionProcessIncarnation) {
        throw new Error('Restart barrier owner incarnation mismatch')
      }
      const expectedOwnerId = expectedState === 'provisional' ? 'worker' : 'runner'
      if (reservation.ownerId !== expectedOwnerId) throw new Error('Restart barrier owner id mismatch')
      if (reservation.token !== execution.runnerClaimToken) throw new Error('Restart barrier runner token mismatch')
      if (reservation.admittedGeneration !== execution.runnerClaimGeneration) {
        throw new Error('Restart barrier runner generation mismatch')
      }
      if (reservation.claimEpoch! <= 0n) throw new Error('Restart barrier epoch is not positive')
      if (expectedPhase === 'none') {
        if (reservation.operationId !== null || reservation.resourceKey !== null) {
          throw new Error('Quiescent restart barrier retained phase identity')
        }
      } else if (!reservation.operationId || !reservation.resourceKey || reservation.phaseSequence <= 0) {
        throw new Error('Open restart barrier is missing its exact phase identity')
      }
      console.log(
        JSON.stringify({
          type: 'barrier',
          incarnation: reservation.ownerIncarnation!,
          ownerId: reservation.ownerId!,
          state: reservation.state,
          phase: reservation.phase,
          phaseSequence: reservation.phaseSequence,
          operationId: reservation.operationId,
          resourceKey: reservation.resourceKey,
          executionStatus: execution.status,
          runnerClaimGeneration: execution.runnerClaimGeneration,
          admittedGeneration: reservation.admittedGeneration!,
          admittedHolderRevision: reservation.admittedHolderRevision!.toString(),
          token: reservation.token!,
          claimEpoch: reservation.claimEpoch!.toString(),
        })
      )
      resolveBarrier()
    } catch (error) {
      rejectBarrier(error)
      throw error
    }
  }
  if (target === 'provisional') {
    Execution.prototype.run = async function () {
      await new Promise(() => {})
    }
  } else if (target === 'requested') {
    ;(SquadWorkerRunner.prototype as any).createSession = async function () {
      await barrier('requested', 'none')
      await new Promise(() => {})
    }
  } else if (target === 'running') {
    ;(SquadWorkerRunner.prototype as any).createSession = async function (scope: any) {
      await scope.runEffect(
        { phase: 'session-create', resourceKey: 'restart:running', successState: 'running' },
        async () => new MockAgentSession() as any
      )
      await barrier('running', 'none')
      await new Promise(() => {})
    }
  } else if (target === 'settlement') {
    ;(SquadWorkerRunner.prototype as any).createSession = async function (scope: any) {
      return scope.runEffect(
        { phase: 'session-create', resourceKey: 'restart:settlement', successState: 'running' },
        async () => new MockAgentSession() as any
      )
    }
    ;(SquadWorkerRunner.prototype as any).sendPrompt = async function () {
      queueMicrotask(() => this.session.pi.simulateNormalEnd('restart settlement'))
    }
    const finishWritePhase = AdmissionReservationStore.prototype.finishWritePhase
    AdmissionReservationStore.prototype.finishWritePhase = async function (lease, phase, nextState) {
      const finished = await finishWritePhase.call(this, lease, phase, nextState)
      if (finished && nextState === 'settling') {
        await barrier('settling', 'none')
        await new Promise(() => {})
      }
      return finished
    }
  } else if (target === 'agent-session') {
    ;(SquadWorkerRunner.prototype as any).createSession = async function (scope: any) {
      return scope.runEffect(
        { phase: 'session-create', resourceKey: 'restart:agent-session', successState: 'running' },
        async () => new MockAgentSession() as any
      )
    }
    ;(SquadWorkerRunner.prototype as any).sendPrompt = async function () {
      await barrier('starting', 'agent-session')
      await new Promise(() => {})
    }
  } else {
    ;(SquadWorkerRunner.prototype as any).createSession = async function (scope: any) {
      await scope.runEffect({ phase: target, resourceKey: `restart:${target}` }, async () => {
        await barrier('starting', target)
        await new Promise(() => {})
      })
    }
  }
  const execution = await Execution.mustFind(executionId)
  const result = await attemptPickup(execution)
  if (result !== 'started') throw new Error(`Owner pickup failed: ${result}`)
  if (target === 'provisional') {
    const [reservation] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, executionId))
    if (reservation?.state !== 'provisional') throw new Error(`Expected provisional, got ${reservation?.state}`)
    await barrier(reservation.state, reservation.phase)
  }
  try {
    await barrierObserved
  } catch (error) {
    console.error(error)
    // A failed durable barrier is fatal to this fixture incarnation. Immediate
    // process exit mirrors a crashed worker and releases its session lock.
    process.exit(92)
  }
  await new Promise(() => {})
} else {
  const settled = new Promise<void>((resolve) => {
    const unsubscribe = eventEmitter.on('execution.completed', (payload) => {
      if (payload.executionId !== executionId) return
      unsubscribe()
      resolve()
    })
  })
  ;(SquadWorkerRunner.prototype as any).createSession = async function (scope: any) {
    return scope.runEffect(
      { phase: 'session-create', resourceKey: 'restart:successor', successState: 'running' },
      async () => new MockAgentSession() as any
    )
  }
  ;(SquadWorkerRunner.prototype as any).sendPrompt = async function () {
    await db.update(messages).set({ pending: false }).where(eq(messages.agentId, this.agent.id))
    queueMicrotask(() => this.session.pi.simulateNormalEnd('restart successor complete'))
  }
  const recovered = await recoverInterruptedExecutionsForStartup()
  const execution = await Execution.mustFind(executionId)
  const result = await attemptPickup(execution)
  const lifecycle = executionLifecycleRegistry.get(executionId)
  if (result === 'started') {
    if (!lifecycle) throw new Error('Successor pickup did not register its production lifecycle')
    await settled
    await lifecycle.runnerFinished
    await lifecycle.settled
    if (executionLifecycleRegistry.get(executionId)) throw new Error('Successor lifecycle remained registered')
    if (isSessionActive(execution.agentId)) throw new Error('Successor session remained active')
  }
  const [reservation] = await db
    .select()
    .from(executionAdmissionReservations)
    .where(eq(executionAdmissionReservations.executionId, executionId))
  const [terminalExecution] = await db.select().from(executions).where(eq(executions.id, executionId))
  if (!terminalExecution || !reservation) throw new Error('Successor terminal rows are missing')
  if (terminalExecution.status !== 'completed') throw new Error(`Successor execution is ${terminalExecution.status}`)
  if (reservation.state !== 'released' || reservation.phase !== 'none') {
    throw new Error(`Successor reservation is ${reservation.state}/${reservation.phase}`)
  }
  if (reservation.ownerId !== 'runner' || reservation.ownerIncarnation !== admissionProcessIncarnation) {
    throw new Error('Successor reservation owner identity mismatch')
  }
  if (reservation.token !== terminalExecution.runnerClaimToken) throw new Error('Successor terminal token mismatch')
  if (reservation.admittedGeneration !== terminalExecution.runnerClaimGeneration) {
    throw new Error('Successor terminal generation mismatch')
  }
  console.log(
    JSON.stringify({
      type: 'settled',
      incarnation: admissionProcessIncarnation,
      recovered,
      result,
      executionStatus: terminalExecution?.status,
      runnerClaimToken: terminalExecution?.runnerClaimToken,
      runnerClaimGeneration: terminalExecution?.runnerClaimGeneration,
      reservationState: reservation.state,
      reservationPhase: reservation.phase,
      ownerId: reservation.ownerId!,
      ownerIncarnation: reservation.ownerIncarnation!,
      admittedHolderRevision: reservation.admittedHolderRevision!.toString(),
      admittedGeneration: reservation.admittedGeneration!,
      token: reservation.token!,
      claimEpoch: reservation.claimEpoch!.toString(),
    })
  )
  await stopAdmissionProcessLiveness()
  process.exit(0)
}
