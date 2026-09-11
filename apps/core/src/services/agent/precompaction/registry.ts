// apps/core/src/services/agent/precompaction/registry.ts
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { PrecompactionController, type PrecompactionDeps } from './controller'
import type { PrecompactionLifecycleEvent } from './debug'

export const MAX_PRECOMPACTION_CONTROLLERS = 64
export const IDLE_READY_TTL_MS = 30 * 60_000

const controllers = new Map<string, PrecompactionController>()

let lifecycleSink: ((agentId: string, event: PrecompactionLifecycleEvent) => void) | undefined

type MetricKey = PrecompactionLifecycleEvent['kind']
const metrics: Record<MetricKey, number> = {
  started: 0,
  succeeded: 0,
  failed: 0,
  aborted: 0,
  superseded: 0,
  consumed: 0,
  rejected: 0,
}

/** Inject the process-wide sink (set once at worker init). Tallies metrics
 * first so counts are kept even if no sink is registered. */
export function setPrecompactionLifecycleSink(
  sink: (agentId: string, event: PrecompactionLifecycleEvent) => void
): void {
  lifecycleSink = sink
}

export function getPrecompactionMetrics(): Readonly<Record<MetricKey, number>> {
  return { ...metrics }
}

function attachLifecycle(agentId: string, controller: PrecompactionController): void {
  controller.onLifecycle = (event) => {
    metrics[event.kind] = (metrics[event.kind] ?? 0) + 1
    lifecycleSink?.(agentId, event)
  }
}

/** Get-or-create the agent's controller and rebind its deps to the live session.
 * Returns the existing controller (preserving state/cache/in-flight bake) when
 * present, or a fresh one otherwise. */
export function bindPrecompactionController(
  agentId: string,
  deps: PrecompactionDeps
): PrecompactionController | undefined {
  let controller = controllers.get(agentId)
  if (controller && controller.isDisposed()) {
    controllers.delete(agentId)
    controller = undefined
  }
  if (controller) {
    controller.rebind(deps)
    controller.reclaimIfStale(IDLE_READY_TTL_MS)
    return controller
  }
  controller = new PrecompactionController(deps)
  attachLifecycle(agentId, controller)
  controllers.set(agentId, controller)
  evictIfOverCap()
  return controller
}

export function getPrecompactionController(agentId: string): PrecompactionController | undefined {
  const controller = controllers.get(agentId)
  if (!controller) return undefined
  if (controller.isDisposed()) {
    controllers.delete(agentId)
    return undefined
  }
  controller.reclaimIfStale(IDLE_READY_TTL_MS)
  return controller
}

export function disposePrecompactionController(agentId: string): void {
  const controller = controllers.get(agentId)
  controller?.dispose()
  controllers.delete(agentId)
}

export function disposeAllPrecompactionControllers(): void {
  for (const controller of controllers.values()) controller.dispose()
  controllers.clear()
}

function evictIfOverCap(): void {
  while (controllers.size > MAX_PRECOMPACTION_CONTROLLERS) {
    let oldestId: string | undefined
    let oldest = Infinity
    for (const [id, controller] of controllers) {
      const at = controller.getLastActivityAt()
      if (at < oldest) {
        oldest = at
        oldestId = id
      }
    }
    if (oldestId === undefined) break
    disposePrecompactionController(oldestId)
  }
}

/** Wire teardown eviction to the existing agent lifecycle events. Call once at
 * worker init. Squad workers are never hard-deleted (only `agent.terminated`),
 * so both events are required; the LRU cap backstops anything that slips through. */
export function registerPrecompactionEviction(): void {
  eventEmitter.on('agent.deleted', ({ agentId }) => disposePrecompactionController(agentId))
  eventEmitter.on('agent.terminated', ({ agentId }) => disposePrecompactionController(agentId))
}

export function __resetPrecompactionRegistryForTests(): void {
  disposeAllPrecompactionControllers()
  lifecycleSink = undefined
  for (const k of Object.keys(metrics) as MetricKey[]) metrics[k] = 0
}
