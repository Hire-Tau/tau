import { createLogger } from '../../../lib/infra/logger'
import { cleanupOrphanToolchainStateBatch, cleanupTerminalToolchainResultsBatch } from './cleanup'

const defaultLogger = createLogger('toolchain-state-cleanup')

export const DEFAULT_TOOLCHAIN_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
export const DEFAULT_TOOLCHAIN_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_TOOLCHAIN_ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1000
export const DEFAULT_TOOLCHAIN_CLEANUP_BATCH_SIZE = 100
export const DEFAULT_TOOLCHAIN_CLEANUP_MAX_BATCHES = 5

type IntervalHandle = ReturnType<typeof setInterval> | number
type CleanupSummary = { terminalDeleted: number; orphanDeleted: number; batches: number }
type Logger = { info(...args: unknown[]): void; error(...args: unknown[]): void }

export async function sweepToolchainState(
  options: {
    terminalRetentionMs?: number
    orphanRetentionMs?: number
    batchSize?: number
    maxBatches?: number
  } = {}
): Promise<CleanupSummary> {
  const terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TOOLCHAIN_TERMINAL_RETENTION_MS
  const orphanRetentionMs = options.orphanRetentionMs ?? DEFAULT_TOOLCHAIN_ORPHAN_RETENTION_MS
  const batchSize = options.batchSize ?? DEFAULT_TOOLCHAIN_CLEANUP_BATCH_SIZE
  const maxBatches = options.maxBatches ?? DEFAULT_TOOLCHAIN_CLEANUP_MAX_BATCHES
  let terminalDeleted = 0
  let orphanDeleted = 0
  let batches = 0
  for (; batches < maxBatches; batches++) {
    const [terminal, orphan] = await Promise.all([
      cleanupTerminalToolchainResultsBatch({ retentionMs: terminalRetentionMs, batchSize }),
      cleanupOrphanToolchainStateBatch({ retentionMs: orphanRetentionMs, batchSize }),
    ])
    terminalDeleted += terminal.length
    orphanDeleted += orphan.length
    if (terminal.length < batchSize && orphan.length < batchSize) {
      batches++
      break
    }
  }
  return { terminalDeleted, orphanDeleted, batches }
}

export class ToolchainStateCleanupScheduler {
  private timer: IntervalHandle | null = null
  private running = false
  private readonly sweep: () => Promise<CleanupSummary>
  private readonly intervalMs: number
  private readonly setIntervalFn: (callback: () => void, intervalMs: number) => IntervalHandle
  private readonly clearIntervalFn: (handle: IntervalHandle) => void
  private readonly logger: Logger
  private readonly now: () => number

  constructor(
    options: {
      sweep?: () => Promise<CleanupSummary>
      intervalMs?: number
      setIntervalFn?: (callback: () => void, intervalMs: number) => IntervalHandle
      clearIntervalFn?: (handle: IntervalHandle) => void
      logger?: Logger
      now?: () => number
    } = {}
  ) {
    this.sweep = options.sweep ?? sweepToolchainState
    this.intervalMs = options.intervalMs ?? DEFAULT_TOOLCHAIN_CLEANUP_INTERVAL_MS
    this.setIntervalFn = options.setIntervalFn ?? setInterval
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval
    this.logger = options.logger ?? defaultLogger
    this.now = options.now ?? Date.now
  }

  start(): void {
    this.stop()
    void this.tick()
    this.timer = this.setIntervalFn(() => void this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer !== null) this.clearIntervalFn(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    const startedAt = this.now()
    try {
      const summary = await this.sweep()
      if (summary.terminalDeleted + summary.orphanDeleted > 0) {
        this.logger.info('Toolchain state cleanup complete', { ...summary, durationMs: this.now() - startedAt })
      }
    } catch (error) {
      this.logger.error('Toolchain state cleanup failed', error)
    } finally {
      this.running = false
    }
  }
}

let scheduler: ToolchainStateCleanupScheduler | null = null

export function startToolchainStateCleanupScheduler(): ToolchainStateCleanupScheduler {
  scheduler ??= new ToolchainStateCleanupScheduler()
  scheduler.start()
  return scheduler
}

export function stopToolchainStateCleanupScheduler(): void {
  scheduler?.stop()
  scheduler = null
}
