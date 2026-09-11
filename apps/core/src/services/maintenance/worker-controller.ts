import { InflightDeduper } from '../../lib/infra/inflight'
import { listen } from '../../lib/infra/local-events'
import { Execution } from '../../entities/Execution'
import { executionLifecycleRegistry } from '../execution/lifecycle-registry'
import { getSession } from '../execution/session-state'
import { MaintenanceStore, maintenanceStore } from './store'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { AdmissionReservationStore } from './admission-reservation'

const DEFAULT_SETTLEMENT_TIMEOUT_MS = 10_000

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('maintenance lifecycle settlement timed out')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class MaintenanceWorkerController {
  private readonly inflight = new InflightDeduper<void>()
  private stopListening: (() => Promise<void>) | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly store: MaintenanceStore = maintenanceStore,
    private readonly settlementTimeoutMs = DEFAULT_SETTLEMENT_TIMEOUT_MS
  ) {}

  // 30s, not 5s: the LISTEN below reconciles real maintenance transitions the
  // moment they happen; this timer is only the crash-recovery backstop. At 5s
  // it cost ~7 transactions (~25 statements, five FOR SHARE reads of the
  // maintenance row) every 5 seconds on instances that never entered
  // maintenance — measured as the largest constant-cost loop in the worker.
  async start(refreshIntervalMs = 30_000): Promise<void> {
    this.stopListening = await listen('instance_maintenance_changed', () => void this.reconcileNow())
    this.timer = setInterval(() => void this.reconcileNow(), refreshIntervalMs)
    await this.reconcileNow()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.stopListening?.()
    this.stopListening = null
  }

  reconcileNow(): Promise<void> {
    return this.inflight.run('maintenance', () => this.reconcile())
  }

  private async classifyExpiredAdmissionEffects(): Promise<void> {
    const recovery = new AdmissionReservationStore('maintenance-recovery', crypto.randomUUID())
    await recovery.markExpiredOpenEffectsUnknown()
    // A crashed Pi-session construction cannot leave a live in-process Pi
    // object. Sandbox ensure/recreate, toolchain, watcher, and managed restart
    // adapters are idempotent/resource-reconciling; requeueing gives each its
    // normal observable adoption-or-safe-replay path under a fresh claim.
    // Session creation requires authoritative owner death: expiry alone can be
    // an event-loop stall or DB outage while AgentSession.create remains live.
    const recovered = [
      ...(await recovery.recoverDeadOwnerQueuedAdmissions()),
      ...(await recovery.recoverUnknownRetryableEffects()),
      ...(await recovery.recoverDeadOwnerSessionCreates()),
      ...(await recovery.recoverDeadOwnerRuntimeEffects()),
    ]
    for (const execution of recovered) {
      eventEmitter.emit('execution.updated', execution)
      if (execution.status === 'queued') eventEmitter.emit('execution.queued', execution)
    }
  }

  private async generationIsCurrent(generation: number): Promise<boolean> {
    const current = await this.store.refresh()
    return current.effective && current.generation === generation
  }

  private async reconcile(): Promise<void> {
    // Boot and periodic reconciliation must fail closed on effects whose owner
    // disappeared mid-I/O. Phase-specific recovery can subsequently inspect
    // the external resource, but quiescence must treat unknown as blocking.
    await this.classifyExpiredAdmissionEffects()
    const state = await this.store.refresh()
    if (!state.effective) {
      const resumed = await this.store.resumeWaitingExecutions()
      for (const execution of resumed) {
        const payload = { executionId: execution.id, agentId: execution.agentId, status: 'queued' as const }
        eventEmitter.emit('execution.updated', payload)
        eventEmitter.emit('execution.queued', payload)
      }
      return
    }
    const generation = state.generation

    const queued = await Execution.list({ status: 'queued' })
    for (const execution of queued) await execution.parkForMaintenance(generation)

    const running = await Execution.list({ status: 'running' })
    for (const execution of running) {
      // The final hold may have been released while the snapshot/list query was
      // in flight. Never let a stale drain touch work admitted after resume.
      if (!(await this.generationIsCurrent(generation))) return

      const lifecycle = executionLifecycleRegistry.get(execution.id)
      if (lifecycle) {
        lifecycle.attachQuiesce(async () => {
          const active = getSession(lifecycle.agentId)
          if (active?.session.pi.isBashRunning) active.session.pi.abortBash()
          await active?.session.pi.abort()
        })
        try {
          await bounded(lifecycle.requestMaintenanceInterrupt(), this.settlementTimeoutMs)
        } catch {
          // Abort rejection/hang is not quiescence. Leave the row running and
          // clear the attempt so the next event/refresh can invoke Pi again.
          lifecycle.resetMaintenanceInterruptAttempt()
          return
        }
        if (!lifecycle.runnerStarted) {
          lifecycle.markRunnerFinished()
          lifecycle.settle()
        }
        try {
          await bounded(lifecycle.settled, this.settlementTimeoutMs)
        } catch {
          // Pi abort completed but an SDK agent_settled notification was lost.
          // Only the runner owns the persistence barrier and active-tool
          // uncertainty marker; never requeue unless its fallback settles both.
          try {
            const settled = await bounded(lifecycle.runFallbackSettlement(), this.settlementTimeoutMs)
            if (!settled) return
          } catch {
            return
          }
        }
        try {
          await bounded(lifecycle.runnerFinished, this.settlementTimeoutMs)
        } catch {
          // Persistence may be settled, but createSession/runner teardown is
          // still alive. Keep the lifecycle registered and never requeue/ack.
          return
        }
      }

      // Release/expiry may race the abort itself. Revalidate immediately before
      // changing durable execution state.
      if (!(await this.generationIsCurrent(generation))) return
      await execution.parkForMaintenance(generation)
    }

    if (!(await this.generationIsCurrent(generation))) return
    // Unknown/provisional/unsettled lifecycle ownership fails closed. Durable
    // quiescence cannot be acknowledged while any runner may still write.
    if (executionLifecycleRegistry.list().length > 0) return
    await this.store.acknowledgeQuiesced(generation, 'worker')
  }
}

export const maintenanceWorkerController = new MaintenanceWorkerController()
