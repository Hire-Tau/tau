/**
 * Lock Manager
 *
 * Provides per-key locking to prevent concurrent operations
 * on the same resource (e.g., memory files, sync operations).
 */

export class LockManager {
  private locks = new Map<string, Promise<void>>()

  /**
   * Execute an operation with an exclusive lock on a key.
   * Operations for the same key are serialized.
   */
  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    // Wait for any existing operation to complete
    const existing = this.locks.get(key)
    if (existing) {
      await existing
    }

    // Create a new promise for this operation
    let resolve: () => void
    const promise = new Promise<void>((r) => {
      resolve = r
    })
    this.locks.set(key, promise)

    try {
      return await operation()
    } finally {
      resolve!()
      this.locks.delete(key)
    }
  }

  /**
   * Check if a lock is currently held for a key.
   */
  isLocked(key: string): boolean {
    return this.locks.has(key)
  }

  /**
   * Get count of active locks.
   */
  get activeLockCount(): number {
    return this.locks.size
  }
}
