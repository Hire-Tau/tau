import { eventEmitter } from '../../lib/infra/event-emitter'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'

// The worker's stream server binds 127.0.0.1 by default (#1348), so this
// poll defaults to loopback too. WORKER_URL still overrides — k8s and compose
// deployments set it to the worker's service/container address.
const WORKER_URL = process.env.WORKER_URL || `http://127.0.0.1:${process.env.WORKER_PORT || 3002}`
const POLL_INTERVAL = 10_000

let currentStatus: 'online' | 'offline' = 'offline'
let runner: PeriodicRunner | null = null

async function checkHealth(): Promise<void> {
  try {
    const response = await fetch(`${WORKER_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })

    if (response.ok) {
      const data = (await response.json()) as {
        activeSessions?: number
        uptime?: number
      }
      if (currentStatus !== 'online') {
        currentStatus = 'online'
        eventEmitter.emit('worker.status', {
          status: 'online',
          activeExecutions: data.activeSessions,
          uptime: data.uptime,
        })
      }
    } else {
      setOffline()
    }
  } catch {
    setOffline()
  }
}

function setOffline(): void {
  if (currentStatus !== 'offline') {
    currentStatus = 'offline'
    eventEmitter.emit('worker.status', { status: 'offline' })
  }
}

export function startWorkerHealthMonitor(): void {
  if (runner) return
  runner = createPeriodicRunner({
    name: 'worker-health',
    intervalMs: POLL_INTERVAL,
    runImmediately: true,
    task: checkHealth,
  })
  runner.start()
}

export function stopWorkerHealthMonitor(): void {
  if (runner) {
    runner.stop()
    runner = null
  }
}

export function getWorkerStatus(): 'online' | 'offline' {
  return currentStatus
}

export function getWorkerUrl(): string {
  return WORKER_URL
}
