/**
 * Debounced Queue
 *
 * Provides debounced scheduling of operations per key.
 * Multiple rapid calls for the same key only execute once
 * after the debounce period.
 */

export interface DebouncedQueueOptions {
  /**
   * Default debounce delay in milliseconds.
   */
  defaultDelayMs?: number

  /**
   * Called when an operation starts executing.
   */
  onStart?: (key: string) => void

  /**
   * Called when an operation completes.
   */
  onComplete?: (key: string, error?: Error) => void
}

export class DebouncedQueue<T = void> {
  private pendingTimers = new Map<string, NodeJS.Timeout>()
  private runningOperations = new Set<string>()
  private defaultDelayMs: number
  private onStart?: (key: string) => void
  private onComplete?: (key: string, error?: Error) => void

  constructor(options: DebouncedQueueOptions = {}) {
    this.defaultDelayMs = options.defaultDelayMs ?? 1000
    this.onStart = options.onStart
    this.onComplete = options.onComplete
  }

  /**
   * Schedule an operation to run after the debounce delay.
   * If already pending for this key, resets the timer.
   * If already running for this key, the schedule is skipped.
   *
   * @param key - Unique key for the operation (e.g., squadId)
   * @param operation - The async operation to execute
   * @param delayMs - Debounce delay (defaults to constructor default)
   */
  schedule(key: string, operation: () => Promise<T>, delayMs?: number): void {
    // Clear existing pending timer
    const existing = this.pendingTimers.get(key)
    if (existing) {
      clearTimeout(existing)
      this.pendingTimers.delete(key)
    }

    // Skip if already running
    if (this.runningOperations.has(key)) {
      return
    }

    // Schedule new execution
    const delay = delayMs ?? this.defaultDelayMs
    const timer = setTimeout(async () => {
      this.pendingTimers.delete(key)

      // Double-check not running (race condition guard)
      if (this.runningOperations.has(key)) {
        return
      }

      this.runningOperations.add(key)
      this.onStart?.(key)

      try {
        await operation()
        this.onComplete?.(key)
      } catch (e) {
        this.onComplete?.(key, e instanceof Error ? e : new Error(String(e)))
      } finally {
        this.runningOperations.delete(key)
      }
    }, delay)

    this.pendingTimers.set(key, timer)
  }

  /**
   * Cancel a pending operation.
   * @returns true if an operation was cancelled
   */
  cancel(key: string): boolean {
    const timer = this.pendingTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.pendingTimers.delete(key)
      return true
    }
    return false
  }

  /**
   * Check if an operation is pending for a key.
   */
  isPending(key: string): boolean {
    return this.pendingTimers.has(key)
  }

  /**
   * Check if an operation is currently running for a key.
   */
  isRunning(key: string): boolean {
    return this.runningOperations.has(key)
  }

  /**
   * Get stats about pending and running operations.
   */
  getStats(): { pending: number; running: number } {
    return {
      pending: this.pendingTimers.size,
      running: this.runningOperations.size,
    }
  }

  /**
   * Clear all pending operations.
   */
  clearAllPending(): void {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer)
    }
    this.pendingTimers.clear()
  }

  /**
   * Clear all running flags (for testing).
   */
  clearAllRunning(): void {
    this.runningOperations.clear()
  }

  /**
   * Mark a key as running (for testing).
   */
  markAsRunning(key: string): void {
    this.runningOperations.add(key)
  }
}
