import { createLogger } from '../../lib/infra/logger'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { requeueAbandonedLeaseExecutions } from './startup-recovery'

/**
 * How often to sweep for executions whose admission lease has lapsed.
 *
 * Leases are heartbeat-renewed every 10s (see AdmissionEffectRunner's default
 * scheduleHeartbeat), so a 30s sweep reacts within roughly one lease window
 * while costing one indexed query per tick.
 */
export const ABANDONED_LEASE_SWEEP_INTERVAL_MS = 30_000

const log = createLogger('abandoned-lease-watch')
let runner: PeriodicRunner | null = null

export function startAbandonedLeaseWatch(): void {
  if (runner) return
  runner = createPeriodicRunner({
    name: 'abandoned-lease-watch',
    intervalMs: ABANDONED_LEASE_SWEEP_INTERVAL_MS,
    task: async () => {
      const requeued = await requeueAbandonedLeaseExecutions()
      // Only speak when something was actually recovered: a silent sweep is the
      // normal case and log noise is what let the orphaned-execution failure go
      // unnoticed for hours.
      for (const executionId of requeued) {
        log.warn(`Re-queued execution ${executionId}: its admission lease expired with no heartbeat`)
      }
    },
  })
  runner.start()
}

export async function stopAbandonedLeaseWatch(): Promise<void> {
  await runner?.stop()
  runner = null
}
