import { test, expect } from 'bun:test'

/**
 * Pins the fetch-isolation guard in `test-setup.ts` (the bunfig preload).
 *
 * bun runs every test file in ONE process, so a file that assigns
 * `globalThis.fetch` and forgets to restore it hands its mock to whichever file
 * runs next. That mock is usually not even a `Response`, so the victim sees
 * `res.status === undefined` — 14 `lib/infra/local-events.test.ts` assertions
 * failed that way on CI for days while passing on every developer laptop,
 * because bun discovers files in filesystem order.
 *
 * The guard is a `beforeEach` registered in the preload. Which hooks a preload
 * can rely on is a bun implementation detail that has ALREADY changed once:
 * `afterAll` there runs per file on 1.2.23 but only once per RUN on 1.3.8, so a
 * guard written against the older behaviour silently protects nothing. These
 * two tests fail the moment that contract shifts again, instead of letting an
 * unrelated file go mysteriously red.
 */
const REAL_FETCH = (globalThis as unknown as { __REAL_FETCH__?: typeof fetch }).__REAL_FETCH__

test('the preload stashes the pristine fetch', () => {
  expect(REAL_FETCH).toBeDefined()
  expect(globalThis.fetch).toBe(REAL_FETCH!)
})

test('a leaked fetch mock is installed here...', () => {
  globalThis.fetch = (async () => ({ ok: true })) as unknown as typeof fetch
  expect(globalThis.fetch).not.toBe(REAL_FETCH!)
})

test('...and the preload has already taken it back by the next test', () => {
  expect(globalThis.fetch).toBe(REAL_FETCH!)
})
