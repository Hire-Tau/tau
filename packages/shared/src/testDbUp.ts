/**
 * Pure orchestration for test:db:up. Reuse a verified live port or allocate a
 * fresh one, then write the port cache only after the database is ready.
 * Injected filesystem and Docker operations keep tests isolated.
 */

export interface EnsureTestDbUpDeps {
  /** Does a `.test-db-port` cache file already exist for this worktree? */
  portFileExists: () => boolean
  /** Read the cached port (only called when portFileExists() is true). */
  readCachedPort: () => number
  /** Is `port` this worktree's compose project, up, and answering real queries? */
  isReady: (port: number) => boolean
  /** Allocate a fresh OS-assigned free port (never 5432). */
  allocatePort: () => number
  /** `docker compose up -d postgres` bound to `port`. */
  dockerComposeUp: (port: number) => void
  /** Poll until `port` is ready or a timeout elapses; true if it became ready. */
  waitUntilReady: (port: number) => boolean
  /** Persist `port` to the `.test-db-port` cache file. */
  writePortFile: (port: number) => void
  log: (msg: string) => void
}

export type EnsureTestDbUpResult = { ok: true; port: number } | { ok: false; error: string }

export function ensureTestDbUp(deps: EnsureTestDbUpDeps): EnsureTestDbUpResult {
  // Reuse a cached port only if it's both a plausible test port (never the
  // production default, 5432) AND independently verified reachable right
  // now — a stale or foreign cache must never short-circuit provisioning.
  if (deps.portFileExists()) {
    const cached = deps.readCachedPort()
    if (cached !== 5432 && deps.isReady(cached)) {
      deps.log(`Test postgres already up on cached port ${cached}`)
      // Re-affirm the cache (harmless no-op when it already matches) so a
      // hand-edited or otherwise-out-of-sync file self-heals here too.
      deps.writePortFile(cached)
      return { ok: true, port: cached }
    }
  }

  const port = deps.allocatePort()
  deps.dockerComposeUp(port)

  if (!deps.waitUntilReady(port)) {
    return { ok: false, error: `Test postgres did not become ready on port ${port} in time` }
  }

  deps.writePortFile(port)
  deps.log(`Test postgres ready on port ${port}`)
  return { ok: true, port }
}
