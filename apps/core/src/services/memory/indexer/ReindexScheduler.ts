/**
 * Memory Reindex Scheduler
 *
 * Provides throttled reindexing of memory files after writes.
 * Ensures only one reindex runs per squad at a time.
 */

import { FileSource } from '../sources/FileSource'
import { ThrottledQueue } from '../../../lib/infra'
import { createLogger } from '../../../lib/infra/logger'
import { SquadSourceConfig } from '../../../entities/SquadSourceConfig'

const log = createLogger('reindex')

// --- Types ---

export interface ReindexSchedulerDeps {
  /**
   * Default throttle interval in milliseconds. Defaults to 60000.
   */
  defaultThrottleMs?: number
}

export interface ReindexStats {
  pending: number
  running: number
}

// --- Constants ---

const DEFAULT_THROTTLE_MS = 60000

// --- Class ---

export class ReindexScheduler {
  private static _instance: ReindexScheduler | null = null

  private queue: ThrottledQueue

  constructor(deps: ReindexSchedulerDeps = {}) {
    this.queue = new ThrottledQueue({
      defaultIntervalMs: deps.defaultThrottleMs ?? DEFAULT_THROTTLE_MS,
      onStart: (squadId) => {
        log.info(`Starting reindex for squad ${squadId}`)
      },
      onComplete: (squadId, error) => {
        if (error) {
          log.error(`Reindex failed for squad ${squadId}:`, error)
        } else {
          log.info(`Completed reindex for squad ${squadId}`)
        }
      },
    })
  }

  /**
   * Get the shared ReindexScheduler instance.
   */
  static instance(): ReindexScheduler {
    if (!ReindexScheduler._instance) {
      ReindexScheduler._instance = new ReindexScheduler()
    }
    return ReindexScheduler._instance
  }

  /**
   * Reset the shared instance (for testing).
   */
  static _reset(): void {
    if (ReindexScheduler._instance) {
      ReindexScheduler._instance.clearAllPending()
      ReindexScheduler._instance.clearAllRunning()
    }
    ReindexScheduler._instance = null
  }

  /**
   * Schedule a reindex for a squad's memory files.
   *
   * Features:
   * - Throttled: Runs at most once per interval while updates continue
   * - Singleton: Skips if reindex already running for this squad
   *
   * @param squadId - The squad to reindex
   * @param intervalMs - Throttle interval in milliseconds (default: 60000)
   */
  schedule(squadId: string, intervalMs?: number): void {
    this.queue.schedule(squadId, () => this.reindexSquadMemory(squadId), intervalMs)
    if (!this.queue.isRunning(squadId)) {
      log.info(`Scheduled reindex for squad ${squadId} within ${intervalMs ?? DEFAULT_THROTTLE_MS}ms`)
    }
  }

  /**
   * Cancel any pending reindex for a squad.
   */
  cancel(squadId: string): boolean {
    const cancelled = this.queue.cancel(squadId)
    if (cancelled) {
      log.info(`Cancelled pending reindex for squad ${squadId}`)
    }
    return cancelled
  }

  /**
   * Check if a reindex is currently running for a squad.
   */
  isRunning(squadId: string): boolean {
    return this.queue.isRunning(squadId)
  }

  /**
   * Check if a reindex is pending for a squad.
   */
  isPending(squadId: string): boolean {
    return this.queue.isPending(squadId)
  }

  /**
   * Get the count of pending and running reindexes.
   */
  getStats(): ReindexStats {
    return this.queue.getStats()
  }

  /**
   * Clear all pending reindexes.
   */
  clearAllPending(): void {
    this.queue.clearAllPending()
  }

  /**
   * Clear all running flags (for testing).
   */
  clearAllRunning(): void {
    this.queue.clearAllRunning()
  }

  /**
   * Force mark a squad as running (for testing).
   */
  markAsRunning(squadId: string): void {
    this.queue.markAsRunning(squadId)
  }

  /**
   * Perform the actual reindex of a squad's memory files.
   */
  private async reindexSquadMemory(squadId: string): Promise<void> {
    const config = await SquadSourceConfig.findBySquadAndType(squadId, 'memory_file')
    if (config?.enabled === false) {
      log.info(`Skipping memory_file reindex for squad ${squadId}; source is disabled`)
      return
    }
    const since = getTimeWindowSince(config?.policy)
    const results = await FileSource.instance().indexAll(squadId, since ? { since } : undefined)
    const successful = results.filter((r) => r.success).length
    const skipped = results.filter((r) => r.skipped).length
    const failed = results.filter((r) => !r.success).length

    log.info(`Indexed ${successful} files for squad ${squadId} (${skipped} unchanged, ${failed} failed)`)
  }
}

function getTimeWindowSince(policy: Record<string, unknown> | undefined): string | undefined {
  const days = policy?.timeWindowDays
  if (!Number.isInteger(days) || (days as number) < 1) return undefined
  return new Date(Date.now() - (days as number) * 24 * 60 * 60 * 1000).toISOString()
}
