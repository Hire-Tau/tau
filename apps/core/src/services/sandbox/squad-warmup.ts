import { ensureConsultantSandbox } from './consultant-warmup'
import { Squad } from '../../entities/Squad'
import { ensureSquadSandbox } from './ensure'
import { shouldKeepSquadWarm, type ShouldKeepSquadWarmDeps } from './keep-warm'
import { maintenanceStore } from '../maintenance/store'
import type { BoxLivenessHintResolver } from './types'

const WARMUP_CONCURRENCY = 3

interface Logger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

interface WarmupOptions {
  ensure?: typeof ensureSquadSandbox
  ensureConsultant?: typeof ensureConsultantSandbox
  /** Injected keep-warm signal deps (test seam); production uses the defaults. */
  keepWarmDeps?: ShouldKeepSquadWarmDeps
  /**
   * Active squads to consider. Supplied by the vm lifecycle tick, which fetches
   * the list once and shares it with the spec reconcile in the same pass (the
   * two steps used to run the identical query back to back). Omitted (or
   * undefined) → this function fetches for itself.
   */
  squads?: Squad[]
  /**
   * vm runtime: resolves each squad box's liveness from what the caller already
   * observed (the lifecycle tick's per-machine `ss -ltnH`). Supplied only by
   * that tick — without it every warmed box is HTTP-probed, which under socket
   * activation WAKES an idle server once a minute.
   */
  resolveBoxLiveness?: BoxLivenessHintResolver
}

export async function warmupActiveSquadSandboxes(log: Logger, options: WarmupOptions = {}): Promise<void> {
  if (maintenanceStore.isPausedCached()) return
  const ensure = options.ensure ?? ensureSquadSandbox
  const squads = options.squads ?? (await Squad.list({ status: 'active', includeAnonymous: false }))
  if (squads.length === 0) return

  // Warm a squad iff the shared keep-warm predicate holds — the SAME predicate
  // the idle reaper's squad keepAlive uses, so a squad that warmup re-ensures is
  // never parked in the same tick (no park → re-warm churn). One `now` keeps the
  // recent-activity window consistent across the batch.
  const now = Date.now()
  const candidates: Squad[] = []
  for (const squad of squads) {
    if (await shouldKeepSquadWarm(squad, now, options.keepWarmDeps)) {
      candidates.push(squad)
    }
  }

  if (candidates.length === 0) return

  log.info(`Warming ${candidates.length} squad sandbox(es)`)

  let nextIndex = 0
  async function warmNext(): Promise<void> {
    while (nextIndex < candidates.length) {
      const squad = candidates[nextIndex++]
      try {
        await ensure(squad, {
          restartManagedLocalDeployments: false,
          boxLiveness: options.resolveBoxLiveness?.(Squad.getSandboxId(squad.id)),
        })
        await (options.ensureConsultant ?? ensureConsultantSandbox)(squad, options.resolveBoxLiveness)
      } catch (err) {
        log.warn(`Squad sandbox warmup failed for ${squad.id}:`, err)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(WARMUP_CONCURRENCY, candidates.length) }, () => warmNext()))
}
