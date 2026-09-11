import type postgres from 'postgres'
import { createPostgresConnection, getConnectionString } from '../db/connection'
import { primaryFirstError, type SecondaryFailure } from './primary-first-error'

export interface MaintenanceBaselineStore {
  refresh(): Promise<{ effective: boolean }>
  isPausedCached(): boolean
}

const MAINTENANCE_FIXTURE_LOCK = 7_401_983_521

export async function restoreMaintenanceBaseline(
  connection: postgres.ReservedSql,
  store: MaintenanceBaselineStore
): Promise<void> {
  await connection`
    INSERT INTO instance_maintenance_state (id) VALUES ('global')
    ON CONFLICT (id) DO NOTHING
  `
  await connection`
    UPDATE instance_maintenance_state
    SET admin_hold = false,
        admin_reason = NULL,
        admin_held_at = NULL,
        admin_held_by = NULL,
        platform_lease_id = NULL,
        platform_lease_owner_token_id = NULL,
        platform_lease_holder = NULL,
        platform_lease_acquired_at = NULL,
        platform_lease_expires_at = NULL,
        updated_at = clock_timestamp()
    WHERE id = 'global'
  `
  const snapshot = await store.refresh()
  if (snapshot.effective || store.isPausedCached()) {
    throw new Error('Maintenance test isolation failed to establish the unpaused baseline')
  }
}

export interface MaintenanceTestIsolationDeps {
  createClient(): {
    reserve(): Promise<postgres.ReservedSql>
    end(options?: { timeout?: number }): Promise<void>
  }
  loadStore(): Promise<MaintenanceBaselineStore>
  restoreBaseline(connection: postgres.ReservedSql, store: MaintenanceBaselineStore): Promise<void>
}

const defaultMaintenanceTestIsolationDeps: MaintenanceTestIsolationDeps = {
  createClient: () => createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} }),
  loadStore: async () => (await import('../services/maintenance/store')).maintenanceStore,
  restoreBaseline: restoreMaintenanceBaseline,
}

type LockState =
  | { kind: 'unproven' }
  | { kind: 'held'; backendPid: number }
  | { kind: 'unlock-attempted'; backendPid: number }
  | { kind: 'released'; backendPid: number }

/**
 * Gives one shared-database test file exclusive ownership of the process-global
 * maintenance singleton. The advisory lock is held on one reserved PostgreSQL
 * session so independently isolated Bun test-file realms still synchronize.
 * Production locking remains unchanged.
 */
export async function acquireMaintenanceTestIsolation(
  overrides: Partial<MaintenanceTestIsolationDeps> = {}
): Promise<() => Promise<void>> {
  const deps = { ...defaultMaintenanceTestIsolationDeps, ...overrides }
  const client = deps.createClient()
  let connection: postgres.ReservedSql | undefined
  let store: MaintenanceBaselineStore | undefined
  let lockState: LockState = { kind: 'unproven' }

  const closeIsolation = async (options: { primary?: unknown; restoreBaseline: boolean }): Promise<void> => {
    let primary = options.primary
    const secondaryFailures: SecondaryFailure[] = []
    const attempt = async (phase: string, operation: () => void | Promise<void>) => {
      try {
        await operation()
      } catch (error) {
        if (primary === undefined) primary = error
        else secondaryFailures.push({ phase, error })
      }
    }

    if (options.restoreBaseline && connection && store) {
      await attempt('maintenance-baseline-restoration', () => deps.restoreBaseline(connection!, store!))
    }
    if (connection && lockState.kind === 'held') {
      const heldBackendPid = lockState.backendPid
      await attempt('maintenance-advisory-unlock', async () => {
        const [current] = await connection!<{ backendPid: number }[]>`
          SELECT pg_backend_pid()::integer AS "backendPid"
        `
        if (current?.backendPid !== heldBackendPid) {
          throw new Error('Maintenance test isolation lost its reserved lock-owning session')
        }
        lockState = { kind: 'unlock-attempted', backendPid: current.backendPid }
        const [result] = await connection!<{ unlocked: boolean }[]>`
          SELECT pg_advisory_unlock(${MAINTENANCE_FIXTURE_LOCK}) AS unlocked
        `
        if (!result?.unlocked) {
          throw new Error('Maintenance test isolation advisory unlock was not owned')
        }
        lockState = { kind: 'released', backendPid: current.backendPid }
      })
    }
    if (connection) {
      await attempt('maintenance-reserved-session-release', () => connection!.release())
    }
    // Ending the private client is the load-bearing fallback that releases a
    // session lock when explicit unlock is indeterminate or fails. Keep this
    // exhaustive disposal even though the reserved connection is released above.
    await attempt('maintenance-client-disposal', () => client.end({ timeout: 5 }))

    if (primary !== undefined) {
      if (secondaryFailures.length === 0) throw primary
      throw primaryFirstError(primary, 'Maintenance test isolation cleanup failed', secondaryFailures)
    }
  }

  try {
    connection = await client.reserve()
    const [owner] = await connection<{ backendPid: number }[]>`
      SELECT pg_backend_pid()::integer AS "backendPid",
             pg_advisory_lock(${MAINTENANCE_FIXTURE_LOCK})
    `
    if (!owner || !Number.isInteger(owner.backendPid)) {
      throw new Error('Maintenance test isolation could not prove advisory-lock ownership')
    }
    lockState = { kind: 'held', backendPid: owner.backendPid }
    store = await deps.loadStore()
    await deps.restoreBaseline(connection, store)
  } catch (error) {
    await closeIsolation({ primary: error, restoreBaseline: false })
    throw error
  }

  let cleanupPromise: Promise<void> | undefined
  return () => {
    cleanupPromise ??= closeIsolation({ restoreBaseline: true })
    return cleanupPromise
  }
}
