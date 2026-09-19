import type { StorageSnapshot } from '@tau/shared'

/** Single-flight scans never hold an HTTP request open during disk traversal.
 * Cache failures too, so a disconnected machine cannot cause a retry storm.
 */
export function createStorageCache(scan: () => Promise<StorageSnapshot>, now = Date.now) {
  let snapshot: StorageSnapshot = { supported: true, scanning: false, scannedAt: null, error: null, machines: [] }
  let pending: Promise<void> | null = null
  let completedAt: number | null = null
  return {
    read(refresh = false): StorageSnapshot {
      const age = completedAt === null ? Infinity : now() - completedAt
      if (!pending && age >= (refresh ? 60_000 : 300_000)) {
        pending = Promise.resolve()
          .then(scan)
          .then((result) => {
            snapshot = result
          })
          .catch(() => {
            snapshot = { ...snapshot, error: 'Storage could not be measured. Try refreshing shortly.' }
          })
          .finally(() => {
            completedAt = now()
            pending = null
          })
      }
      return { ...snapshot, scanning: pending !== null }
    },
    settled: () => pending ?? Promise.resolve(),
  }
}
