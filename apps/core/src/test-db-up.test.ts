import { describe, test, expect } from 'bun:test'
import { ensureTestDbUp, type EnsureTestDbUpDeps } from './test-db-up'

function fakeDeps(overrides: Partial<EnsureTestDbUpDeps> = {}): EnsureTestDbUpDeps {
  const calls: string[] = []
  return {
    portFileExists: () => false,
    readCachedPort: () => {
      throw new Error('readCachedPort should not be called when portFileExists() is false')
    },
    isReady: () => false,
    allocatePort: () => 54321,
    dockerComposeUp: () => {
      calls.push('up')
    },
    waitUntilReady: () => true,
    writePortFile: () => {
      calls.push('write')
    },
    log: () => {},
    ...overrides,
  }
}

describe('ensureTestDbUp', () => {
  test('fresh worktree (no cached port): allocates a free port, brings the container up, and WRITES the port file', () => {
    const written: number[] = []
    const upPorts: number[] = []
    const result = ensureTestDbUp(
      fakeDeps({
        portFileExists: () => false,
        allocatePort: () => 55123,
        dockerComposeUp: (port) => upPorts.push(port),
        waitUntilReady: () => true,
        writePortFile: (port) => written.push(port),
      })
    )
    expect(result).toEqual({ ok: true, port: 55123 })
    expect(upPorts).toEqual([55123])
    expect(written).toEqual([55123])
  })

  test('cached port that is still reachable: reuses it without allocating a new one or re-upping', () => {
    let upCalled = false
    let allocateCalled = false
    const written: number[] = []
    const result = ensureTestDbUp(
      fakeDeps({
        portFileExists: () => true,
        readCachedPort: () => 49999,
        isReady: (port) => port === 49999,
        allocatePort: () => {
          allocateCalled = true
          return 1
        },
        dockerComposeUp: () => {
          upCalled = true
        },
        writePortFile: (port) => written.push(port),
      })
    )
    expect(result).toEqual({ ok: true, port: 49999 })
    expect(upCalled).toBe(false)
    expect(allocateCalled).toBe(false)
    // Re-affirming the cache file on the reuse path is harmless and keeps
    // behavior uniform, but the key invariant under test is that no new
    // container/port was allocated.
  })

  test('cached port exists but is stale (container down or reassigned): allocates a fresh port and brings a new container up', () => {
    const upPorts: number[] = []
    const written: number[] = []
    const result = ensureTestDbUp(
      fakeDeps({
        portFileExists: () => true,
        readCachedPort: () => 40000,
        isReady: (port) => port !== 40000, // cached port is NOT ready; only the allocated one is
        allocatePort: () => 60000,
        dockerComposeUp: (port) => upPorts.push(port),
        writePortFile: (port) => written.push(port),
      })
    )
    expect(result).toEqual({ ok: true, port: 60000 })
    expect(upPorts).toEqual([60000])
    expect(written).toEqual([60000])
  })

  test('never trusts a cached port of 5432 (production) even if it reports ready', () => {
    const upPorts: number[] = []
    const result = ensureTestDbUp(
      fakeDeps({
        portFileExists: () => true,
        readCachedPort: () => 5432,
        isReady: () => true, // would say "ready" but must never be trusted for 5432
        allocatePort: () => 61000,
        dockerComposeUp: (port) => upPorts.push(port),
      })
    )
    expect(result).toEqual({ ok: true, port: 61000 })
    expect(upPorts).toEqual([61000])
  })

  test('container never becomes ready: fails with a clear error and does NOT write a port file', () => {
    const written: number[] = []
    const result = ensureTestDbUp(
      fakeDeps({
        allocatePort: () => 62000,
        waitUntilReady: () => false,
        writePortFile: (port) => written.push(port),
      })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/62000/)
      expect(result.error).toMatch(/not become ready/i)
    }
    expect(written).toEqual([])
  })
})
