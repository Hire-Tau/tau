import { describe, expect, test } from 'bun:test'
import { createInvalidationCoalescer } from './invalidationCoalescer'

/**
 * Timers and microtasks are injected rather than awaited, so every assertion is
 * about ordering the coalescer controls instead of about elapsed wall time. No
 * sleeps: a test that passes because it waited long enough would also pass with
 * the coalescing removed.
 */
function harness(windowMs = 150, respond?: (key: string) => void | 'retry') {
  const invalidated: string[] = []
  let microtasks: (() => void)[] = []
  const timers = new Map<number, { callback: () => void; dueAt: number }>()
  let nextHandle = 1
  let clock = 0

  const coalescer = createInvalidationCoalescer(
    (queryKey) => {
      const key = queryKey.join('/')
      invalidated.push(key)
      return respond?.(key)
    },
    {
      windowMs,
      scheduleMicrotask: (callback) => microtasks.push(callback),
      schedule: (callback, ms) => {
        const handle = nextHandle++
        timers.set(handle, { callback, dueAt: clock + ms })
        return handle as unknown as ReturnType<typeof setTimeout>
      },
      cancel: (handle) => timers.delete(handle as unknown as number),
    }
  )

  return {
    coalescer,
    invalidated,
    pendingTimers: () => timers.size,
    /** Run every queued microtask, including ones queued by those microtasks. */
    drainMicrotasks() {
      while (microtasks.length > 0) {
        const batch = microtasks
        microtasks = []
        for (const task of batch) task()
      }
    },
    /** Advance to the next due timer and fire it. */
    advance(ms: number) {
      clock += ms
      for (const [handle, timer] of [...timers]) {
        if (timer.dueAt > clock) continue
        timers.delete(handle)
        timer.callback()
      }
    },
  }
}

describe('createInvalidationCoalescer', () => {
  test('an isolated event flushes on the microtask, without waiting out the window', () => {
    const h = harness()

    h.coalescer.queue(['agents', 'detail', 'a'])
    // Not synchronous — the handler must finish queueing first.
    expect(h.invalidated).toEqual([])

    h.drainMicrotasks()

    expect(h.invalidated).toEqual(['agents/detail/a'])
  })

  test('keys queued by one event flush together, not split across windows', () => {
    const h = harness()

    // What a single `agent.updated` handler does: several keys, synchronously.
    h.coalescer.queue(['agents', 'detail', 'a'])
    h.coalescer.queue(['agents', 'list'])
    h.coalescer.queue(['actions'])

    h.drainMicrotasks()

    expect(h.invalidated).toEqual(['agents/detail/a', 'agents/list', 'actions'])
  })

  test('a burst inside the window costs one extra flush, not one per event', () => {
    const h = harness()

    h.coalescer.queue(['agents', 'list'])
    h.drainMicrotasks()
    expect(h.invalidated).toEqual(['agents/list'])

    // 20 more frames arrive before the window closes.
    for (let i = 0; i < 20; i++) {
      h.coalescer.queue(['agents', 'list'])
      h.drainMicrotasks()
    }
    // Still just the leading flush — the burst has not refetched anything.
    expect(h.invalidated).toEqual(['agents/list'])

    h.advance(150)

    // One trailing flush covers all 20.
    expect(h.invalidated).toEqual(['agents/list', 'agents/list'])
  })

  test('an ancestor and descendant queued in one logical event collapse to the ancestor', () => {
    const ancestor = ['squads']
    const descendant = ['squads', 'detail', 'squad-1']
    for (const keys of [
      [ancestor, descendant],
      [descendant, ancestor],
    ]) {
      const { coalescer, invalidated, drainMicrotasks } = harness()
      for (const key of keys) coalescer.queue(key)
      drainMicrotasks()
      expect(invalidated).toEqual(['squads'])
    }
  })

  test('distinct keys in a burst are each invalidated once', () => {
    const h = harness()

    h.coalescer.queue(['agents', 'detail', 'a'])
    h.drainMicrotasks()
    for (let i = 0; i < 5; i++) {
      h.coalescer.queue(['agents', 'detail', 'a'])
      h.coalescer.queue(['agents', 'detail', 'b'])
      h.coalescer.queue(['agents', 'list'])
    }
    h.advance(150)

    expect(h.invalidated).toEqual(['agents/detail/a', 'agents/detail/a', 'agents/detail/b', 'agents/list'])
  })

  test("a callback returning 'retry' is re-offered the key each window until it accepts, then the cadence dies", () => {
    let accept = false
    const h = harness(150, () => (accept ? undefined : 'retry'))

    h.coalescer.queue(['agents', 'list'])
    h.drainMicrotasks()
    // Offered on the leading flush, declined, so it stays queued.
    expect(h.invalidated).toEqual(['agents/list'])

    h.advance(150)
    // Re-offered on the trailing window without any new queue() call.
    expect(h.invalidated).toEqual(['agents/list', 'agents/list'])

    accept = true
    h.advance(150)
    expect(h.invalidated).toEqual(['agents/list', 'agents/list', 'agents/list'])

    // Accepted: nothing pending, so the next window closes the cadence.
    h.advance(150)
    expect(h.invalidated).toHaveLength(3)
    expect(h.pendingTimers()).toBe(0)
  })

  test('a retried key de-duplicates with the same key queued mid-window, and other keys are unaffected', () => {
    let accept = false
    const h = harness(150, (key) => (key === 'agents/list' && !accept ? 'retry' : undefined))

    h.coalescer.queue(['agents', 'list'])
    h.drainMicrotasks()
    expect(h.invalidated).toEqual(['agents/list'])

    // The same key arrives again from a live event, plus an unrelated key.
    h.coalescer.queue(['agents', 'list'])
    h.coalescer.queue(['actions'])
    accept = true
    h.advance(150)

    // One offer for the retried+re-queued key, one for the newcomer — no dupes.
    expect(h.invalidated).toEqual(['agents/list', 'agents/list', 'actions'])
  })

  test('a sustained stream keeps the window cadence instead of flushing again immediately', () => {
    const h = harness()

    h.coalescer.queue(['agents', 'list'])
    h.drainMicrotasks()
    h.coalescer.queue(['agents', 'list'])

    // Window closes with work pending, so it flushes AND re-arms.
    h.advance(150)
    expect(h.invalidated).toEqual(['agents/list', 'agents/list'])

    // The next frame lands 1ms later. If the window did not re-arm, this would
    // take the leading-edge microtask path and flush a third time right on top
    // of the previous flush — the storm, at window scale.
    h.coalescer.queue(['agents', 'list'])
    h.drainMicrotasks()

    expect(h.invalidated).toEqual(['agents/list', 'agents/list'])

    h.advance(150)
    expect(h.invalidated).toEqual(['agents/list', 'agents/list', 'agents/list'])
  })

  test('an idle coalescer holds no timer between bursts', () => {
    const h = harness()

    h.coalescer.queue(['agents', 'list'])
    h.drainMicrotasks()
    expect(h.pendingTimers()).toBe(1)

    // Window closes with nothing pending: the cadence stops instead of
    // re-arming forever.
    h.advance(150)
    expect(h.pendingTimers()).toBe(0)
    expect(h.invalidated).toEqual(['agents/list'])
  })

  test('dispose drops queued work and cancels the window', () => {
    const h = harness()

    h.coalescer.queue(['agents', 'list'])
    h.drainMicrotasks()
    h.coalescer.queue(['agents', 'detail', 'a'])
    h.coalescer.dispose()

    expect(h.pendingTimers()).toBe(0)

    h.advance(150)
    h.drainMicrotasks()

    // Only the pre-dispose flush ever ran.
    expect(h.invalidated).toEqual(['agents/list'])
  })

  test('a re-entrant queue from inside a flush cannot bypass the window or orphan its timer', () => {
    const invalidated: string[] = []
    let microtasks: (() => void)[] = []
    const timers = new Map<number, { callback: () => void; dueAt: number }>()
    let nextHandle = 1
    let reentered = false

    // The hazard: `flush()` runs with `windowHandle === null`, so a key queued
    // synchronously from an invalidate callback used to pass the open-window
    // short-circuit, schedule its own microtask, and call openWindow a second
    // time — replacing the handle and leaking the first timer past dispose().
    const coalescer = createInvalidationCoalescer(
      (queryKey) => {
        invalidated.push(queryKey.join('/'))
        if (reentered) return
        reentered = true
        coalescer.queue(['agents', 'reentrant'])
      },
      {
        windowMs: 150,
        scheduleMicrotask: (callback) => microtasks.push(callback),
        schedule: (callback, ms) => {
          const handle = nextHandle++
          timers.set(handle, { callback, dueAt: ms })
          return handle as unknown as ReturnType<typeof setTimeout>
        },
        cancel: (handle) => timers.delete(handle as unknown as number),
      }
    )

    coalescer.queue(['agents', 'list'])
    while (microtasks.length > 0) {
      const batch = microtasks
      microtasks = []
      for (const task of batch) task()
    }

    // The re-entrant key waits for the window rather than flushing on top of
    // the flush that produced it.
    expect(invalidated).toEqual(['agents/list'])
    // Exactly one live timer — a second would be unreachable by dispose().
    expect(timers.size).toBe(1)

    coalescer.dispose()
    expect(timers.size).toBe(0)
  })

  test('logically identical keys de-duplicate regardless of object property order', () => {
    const h = harness()

    // `queryKeys.agents.list(filters)` and friends take an object. JSON.stringify
    // is property-order sensitive, so it would treat these as two keys.
    h.coalescer.queue(['agents', 'list', { scopeType: 'squad', scopeId: 's1' }])
    h.coalescer.queue(['agents', 'list', { scopeId: 's1', scopeType: 'squad' }])
    h.drainMicrotasks()

    expect(h.invalidated).toHaveLength(1)
  })

  test('queueing after dispose is inert', () => {
    const h = harness()

    h.coalescer.dispose()
    h.coalescer.queue(['agents', 'list'])
    h.drainMicrotasks()
    h.advance(150)

    expect(h.invalidated).toEqual([])
  })
})

/**
 * Every test above injects `windowMs`, `schedule`, `cancel` and
 * `scheduleMicrotask`, so none of them constructs the coalescer the way
 * `QueryInvalidator` actually does. An adversarial review exploited exactly
 * that: changing the default window from 150ms to 100 seconds, and neutering
 * the default `cancel`, both left the suite green. These tests use the real
 * defaults. The waits are the mechanism under test, not a workaround for flake.
 */
describe('createInvalidationCoalescer — real defaults, no injection', () => {
  test('flushes on a real microtask and re-flushes within the real default window', async () => {
    const invalidated: string[] = []
    const coalescer = createInvalidationCoalescer((queryKey) => invalidated.push(queryKey.join('/')))

    coalescer.queue(['agents', 'a'])
    expect(invalidated).toEqual([])

    await Promise.resolve()
    expect(invalidated).toEqual(['agents/a'])

    // Queued while the window is open: must flush when it closes. If the
    // default window were much larger than 150ms this never arrives.
    coalescer.queue(['agents', 'b'])
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(invalidated).toEqual(['agents/a', 'agents/b'])

    coalescer.dispose()
  })

  test('dispose cancels the live window timer via the default cancel', () => {
    // Asserting on `invalidated` cannot prove the default `cancel` works: the
    // window callback bails on its `disposed` guard and `dispose` also clears
    // `pending`, so a no-op `cancel` yields identical output. `cancel`'s real
    // job is resource hygiene — leave no dangling timer — so the timer itself is
    // what must be observed. Spy on the real global timers; inject only a
    // synchronous microtask so `openWindow` runs deterministically, leaving the
    // default `cancel` (clearTimeout) as the thing under test.
    const live = new Set<number>()
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    let handleSeq = 1
    // @ts-expect-error minimal timer stand-ins for the spy
    globalThis.setTimeout = (_callback: () => void) => {
      const handle = handleSeq++
      live.add(handle)
      return handle
    }
    // @ts-expect-error minimal timer stand-ins for the spy
    globalThis.clearTimeout = (handle: number) => {
      live.delete(handle)
    }
    try {
      const coalescer = createInvalidationCoalescer(() => {}, { scheduleMicrotask: (callback) => callback() })

      coalescer.queue(['agents', 'a'])
      // The synchronous microtask flushed and opened the window: one live timer.
      expect(live.size).toBe(1)

      coalescer.dispose()
      // The default cancel must have cleared it. A no-op cancel leaves it at 1.
      expect(live.size).toBe(0)
    } finally {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })
})
