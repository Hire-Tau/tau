import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireTestDbLock, testDbLockPath, withTestDbLock, withTestDbLockSync } from './testDbLock'

// Isolate every test's lockfile under its own scratch repoRoot string so
// tests can't collide with each other or with a real dev run's lock.
function fakeRepoRoot(): string {
  return mkdtempSync(join(tmpdir(), 'tau-test-db-lock-test-'))
}

const cleanupPaths: string[] = []
afterEach(() => {
  while (cleanupPaths.length) {
    const p = cleanupPaths.pop()!
    try {
      rmSync(p, { force: true })
    } catch {
      // ignore
    }
  }
})

describe('testDbLockPath', () => {
  test('is deterministic for the same repoRoot', () => {
    const root = fakeRepoRoot()
    expect(testDbLockPath(root)).toBe(testDbLockPath(root))
  })

  test('differs for different repoRoots (no cross-worktree collisions)', () => {
    expect(testDbLockPath(fakeRepoRoot())).not.toBe(testDbLockPath(fakeRepoRoot()))
  })
})

describe('acquireTestDbLock', () => {
  test('acquires immediately when no lock is held, and release() clears it', () => {
    const root = fakeRepoRoot()
    const lockPath = testDbLockPath(root)
    cleanupPaths.push(lockPath)

    const handle = acquireTestDbLock(root)
    expect(existsSync(lockPath)).toBe(true)
    handle.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  test('a second acquire times out while the first is still held', () => {
    const root = fakeRepoRoot()
    const lockPath = testDbLockPath(root)
    cleanupPaths.push(lockPath)

    const first = acquireTestDbLock(root)
    expect(() => acquireTestDbLock(root, { timeoutMs: 300 })).toThrow(/Timed out/)
    first.release()

    // Once released, a fresh acquire succeeds immediately again.
    const second = acquireTestDbLock(root)
    second.release()
  })

  test('the timeout error names the lockfile path so a stuck run is diagnosable', () => {
    const root = fakeRepoRoot()
    const lockPath = testDbLockPath(root)
    cleanupPaths.push(lockPath)

    const first = acquireTestDbLock(root)
    expect(() => acquireTestDbLock(root, { timeoutMs: 300 })).toThrow(lockPath)
    first.release()
  })

  test('reclaims a lockfile abandoned by a dead PID instead of waiting out the timeout', () => {
    const root = fakeRepoRoot()
    const lockPath = testDbLockPath(root)
    cleanupPaths.push(lockPath)

    // PID 2^31-2 is never a real running process. Write a lock token that
    // looks like it was left behind by a killed holder.
    writeFileSync(lockPath, '2147483646:1')

    const start = Date.now()
    const handle = acquireTestDbLock(root, { timeoutMs: 5000 })
    const elapsedMs = Date.now() - start
    handle.release()

    // Reclaim should happen on (near) the first poll, nowhere near the
    // 5s timeout budget — proves it didn't just get lucky waiting it out.
    expect(elapsedMs).toBeLessThan(2000)
  })

  test('does not reclaim a lockfile whose PID is this very (alive) process', () => {
    const root = fakeRepoRoot()
    const lockPath = testDbLockPath(root)
    cleanupPaths.push(lockPath)

    // Our own PID is definitely alive, so a lock "held" by it must not be
    // treated as abandoned.
    writeFileSync(lockPath, `${process.pid}:1`)

    expect(() => acquireTestDbLock(root, { timeoutMs: 300 })).toThrow(/Timed out/)
  })
})

describe('withTestDbLock', () => {
  test('runs the section under the lock and releases it afterward, even on throw', async () => {
    const root = fakeRepoRoot()
    const lockPath = testDbLockPath(root)
    cleanupPaths.push(lockPath)

    await expect(
      withTestDbLock(root, () => {
        expect(existsSync(lockPath)).toBe(true)
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(existsSync(lockPath)).toBe(false)
  })

  test('returns the section result', async () => {
    const root = fakeRepoRoot()
    cleanupPaths.push(testDbLockPath(root))
    const result = await withTestDbLock(root, () => 42)
    expect(result).toBe(42)
  })
})

describe('withTestDbLockSync', () => {
  test('runs the section under the lock and releases it afterward, even on throw', () => {
    const root = fakeRepoRoot()
    const lockPath = testDbLockPath(root)
    cleanupPaths.push(lockPath)

    expect(() =>
      withTestDbLockSync(root, () => {
        expect(existsSync(lockPath)).toBe(true)
        throw new Error('boom')
      })
    ).toThrow('boom')

    expect(existsSync(lockPath)).toBe(false)
  })

  test('returns the section result', () => {
    const root = fakeRepoRoot()
    cleanupPaths.push(testDbLockPath(root))
    expect(withTestDbLockSync(root, () => 7)).toBe(7)
  })
})
