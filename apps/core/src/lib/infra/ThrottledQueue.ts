export interface ThrottledQueueOptions {
  /**
   * Default throttle interval in milliseconds.
   */
  defaultIntervalMs?: number

  /**
   * Called when an operation starts executing.
   */
  onStart?: (key: string) => void

  /**
   * Called when an operation completes.
   */
  onComplete?: (key: string, error?: Error) => void
}

interface ScheduledOperation<T> {
  operation: () => Promise<T>
  timer: NodeJS.Timeout
}

/**
 * Provides trailing throttle scheduling of operations per key.
 *
 * Multiple calls for the same key within the throttle interval execute at most
 * once at the end of that interval. Additional calls after execution starts can
 * schedule the next interval, so continuous updates continue to run at most once
 * per interval instead of being postponed indefinitely.
 */
export class ThrottledQueue<T = void> {
  private pendingOperations = new Map<string, ScheduledOperation<T>>()
  private runningOperations = new Set<string>()
  private lastRunAt = new Map<string, number>()
  private defaultIntervalMs: number
  private onStart?: (key: string) => void
  private onComplete?: (key: string, error?: Error) => void

  constructor(options: ThrottledQueueOptions = {}) {
    this.defaultIntervalMs = options.defaultIntervalMs ?? 1000
    this.onStart = options.onStart
    this.onComplete = options.onComplete
  }

  schedule(key: string, operation: () => Promise<T>, intervalMs?: number): void {
    const existing = this.pendingOperations.get(key)
    if (existing) {
      existing.operation = operation
      return
    }

    const interval = intervalMs ?? this.defaultIntervalMs
    const lastRunAt = this.lastRunAt.get(key)
    const now = Date.now()
    const delay = lastRunAt === undefined ? interval : Math.max(0, interval - (now - lastRunAt))

    const scheduled: ScheduledOperation<T> = {
      operation,
      timer: setTimeout(() => void this.run(key), delay),
    }
    this.pendingOperations.set(key, scheduled)
  }

  private async run(key: string): Promise<void> {
    const scheduled = this.pendingOperations.get(key)
    if (!scheduled) return

    this.pendingOperations.delete(key)

    if (this.runningOperations.has(key)) {
      this.schedule(key, scheduled.operation)
      return
    }

    this.runningOperations.add(key)
    this.lastRunAt.set(key, Date.now())
    this.onStart?.(key)

    try {
      await scheduled.operation()
      this.onComplete?.(key)
    } catch (e) {
      this.onComplete?.(key, e instanceof Error ? e : new Error(String(e)))
    } finally {
      this.runningOperations.delete(key)
    }
  }

  cancel(key: string): boolean {
    const scheduled = this.pendingOperations.get(key)
    if (!scheduled) return false

    clearTimeout(scheduled.timer)
    this.pendingOperations.delete(key)
    return true
  }

  isPending(key: string): boolean {
    return this.pendingOperations.has(key)
  }

  isRunning(key: string): boolean {
    return this.runningOperations.has(key)
  }

  getStats(): { pending: number; running: number } {
    return {
      pending: this.pendingOperations.size,
      running: this.runningOperations.size,
    }
  }

  clearAllPending(): void {
    for (const scheduled of this.pendingOperations.values()) {
      clearTimeout(scheduled.timer)
    }
    this.pendingOperations.clear()
  }

  clearAllRunning(): void {
    this.runningOperations.clear()
  }

  markAsRunning(key: string): void {
    this.runningOperations.add(key)
  }
}
