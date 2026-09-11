import { expect, test } from 'bun:test'
import type postgres from 'postgres'
import { maintenanceStore } from '../services/maintenance/store'
import { acquireMaintenanceTestIsolation, restoreMaintenanceBaseline } from './maintenance-test-isolation'

const store = { refresh: async () => ({ effective: false }), isPausedCached: () => false }

interface HarnessOptions {
  backendPid?: number
  currentBackendPid?: number
  reserveError?: unknown
  lockError?: unknown
  malformedOwner?: boolean
  unlockError?: unknown
  unlocked?: boolean
  releaseError?: unknown
  endError?: unknown
  restoreErrors?: unknown[]
  loadStoreError?: unknown
}

function createHarness(options: HarnessOptions = {}) {
  const calls: string[] = []
  const backendPid = options.backendPid ?? 41
  let restoreCall = 0
  const connection = Object.assign(
    async (strings: TemplateStringsArray) => {
      const sql = strings.join('?')
      if (sql.includes('pg_advisory_lock')) {
        calls.push(`lock:backend=${backendPid}`)
        if (options.lockError) throw options.lockError
        return options.malformedOwner ? [] : [{ backendPid }]
      }
      if (sql.includes('pg_backend_pid')) {
        const current = options.currentBackendPid ?? backendPid
        calls.push(`backend:${current}`)
        return [{ backendPid: current }]
      }
      if (sql.includes('pg_advisory_unlock')) {
        calls.push('unlock:key=7401983521')
        if (options.unlockError) throw options.unlockError
        return [{ unlocked: options.unlocked ?? true }]
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    {
      release: () => {
        calls.push('release')
        if (options.releaseError) throw options.releaseError
      },
    }
  ) as unknown as postgres.ReservedSql

  return {
    calls,
    deps: {
      createClient: () => ({
        reserve: async () => {
          calls.push('reserve')
          if (options.reserveError) throw options.reserveError
          return connection
        },
        end: async ({ timeout }: { timeout?: number } = {}) => {
          calls.push(`end:timeout=${timeout}`)
          if (options.endError) throw options.endError
        },
      }),
      loadStore: async () => {
        calls.push('load-store')
        if (options.loadStoreError) throw options.loadStoreError
        return store
      },
      restoreBaseline: async () => {
        calls.push('baseline')
        const error = options.restoreErrors?.[restoreCall++]
        if (error) throw error
      },
    },
  }
}

test('restores the database and realm cache before fixture ownership begins', async () => {
  const statements: string[] = []
  const connection = ((strings: TemplateStringsArray) => {
    statements.push(strings.join('?'))
    return Promise.resolve([])
  }) as unknown as postgres.ReservedSql
  let cachedPaused = true
  let refreshCalls = 0
  const localStore = {
    async refresh() {
      refreshCalls += 1
      cachedPaused = false
      return { effective: false }
    },
    isPausedCached: () => cachedPaused,
  }

  await restoreMaintenanceBaseline(connection, localStore)

  expect(statements).toHaveLength(2)
  expect(statements[0]).toContain('INSERT INTO instance_maintenance_state')
  expect(statements[1]).toContain('UPDATE instance_maintenance_state')
  expect(refreshCalls).toBe(1)
  expect(localStore.isPausedCached()).toBe(false)
})

test('establishes the baseline after proving lock ownership and releases in order', async () => {
  const harness = createHarness()
  const release = await acquireMaintenanceTestIsolation(harness.deps)

  await release()

  expect(harness.calls).toEqual([
    'reserve',
    'lock:backend=41',
    'load-store',
    'baseline',
    'baseline',
    'backend:41',
    'unlock:key=7401983521',
    'release',
    'end:timeout=5',
  ])
})

test('unlocks a proven lock when the acquisition baseline fails', async () => {
  const primary = new Error('baseline failed')
  const harness = createHarness({ restoreErrors: [primary] })

  await expect(acquireMaintenanceTestIsolation(harness.deps)).rejects.toBe(primary)
  expect(harness.calls).toEqual([
    'reserve',
    'lock:backend=41',
    'load-store',
    'baseline',
    'backend:41',
    'unlock:key=7401983521',
    'release',
    'end:timeout=5',
  ])
})

test.each([
  ['reservation rejection', { reserveError: new Error('reserve') }, ['reserve', 'end:timeout=5']],
  ['lock rejection', { lockError: new Error('lock') }, ['reserve', 'lock:backend=41', 'release', 'end:timeout=5']],
  ['malformed ownership proof', { malformedOwner: true }, ['reserve', 'lock:backend=41', 'release', 'end:timeout=5']],
  [
    'store load rejection',
    { loadStoreError: new Error('store') },
    ['reserve', 'lock:backend=41', 'load-store', 'backend:41', 'unlock:key=7401983521', 'release', 'end:timeout=5'],
  ],
] as const)('does not guess advisory ownership after %s', async (_name, options, expectedCalls) => {
  const harness = createHarness(options)
  await expect(acquireMaintenanceTestIsolation(harness.deps)).rejects.toBeDefined()
  expect(harness.calls).toEqual([...expectedCalls])
})

test('memoizes exhaustive cleanup and preserves primary-first failures', async () => {
  const baseline = new Error('baseline secret')
  const harness = createHarness({
    restoreErrors: [undefined, baseline],
    unlockError: new Error('unlock secret'),
    releaseError: new Error('release secret'),
    endError: new Error('end secret'),
  })
  const release = await acquireMaintenanceTestIsolation(harness.deps)
  const first = release()
  const second = release()
  expect(first).toBe(second)

  let caught: unknown
  try {
    await first
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(AggregateError)
  expect((caught as AggregateError).errors[0]).toBe(baseline)
  expect((caught as Error).cause).toBe(baseline)
  expect((caught as AggregateError).errors.slice(1).map((error) => (error as Error).message)).toEqual([
    'Secondary failure: maintenance-advisory-unlock',
    'Secondary failure: maintenance-reserved-session-release',
    'Secondary failure: maintenance-client-disposal',
  ])
  expect(harness.calls.filter((call) => call.startsWith('unlock'))).toHaveLength(1)
  expect(harness.calls.at(-1)).toBe('end:timeout=5')
  await expect(release()).rejects.toBe(caught)
})

test('refuses to unlock a different backend but still disposes the session', async () => {
  const harness = createHarness({ currentBackendPid: 42 })
  const release = await acquireMaintenanceTestIsolation(harness.deps)

  await expect(release()).rejects.toThrow('lost its reserved lock-owning session')
  expect(harness.calls).not.toContain('unlock:key=7401983521')
  expect(harness.calls.slice(-2)).toEqual(['release', 'end:timeout=5'])
})

test('maintenance fixture ownership stays exclusive across interleaved test realms', async () => {
  const releaseFirst = await acquireMaintenanceTestIsolation()
  let secondAcquired = false
  const second = acquireMaintenanceTestIsolation().then((release) => {
    secondAcquired = true
    return release
  })

  await Bun.sleep(25)
  expect(secondAcquired).toBe(false)

  await maintenanceStore.initialize()
  await maintenanceStore.setAdminHold({ active: true, actor: 'isolation-test' })
  expect(maintenanceStore.isPausedCached()).toBe(true)

  await releaseFirst()
  expect(maintenanceStore.isPausedCached()).toBe(false)
  const releaseSecond = await second
  expect(secondAcquired).toBe(true)
  await releaseSecond()
})
