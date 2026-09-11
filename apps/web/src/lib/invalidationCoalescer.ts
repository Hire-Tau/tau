import { hashKey, partialMatchKey } from '@tanstack/react-query'

/**
 * Collapses bursts of cache invalidations into at most one flush per window.
 *
 * WS events arrive far faster than the UI can usefully refetch: a busy instance
 * emits ~44 `agent.updated` frames per minute, and each one previously drove an
 * immediate `invalidateQueries`. Every mounted observer refetched on every
 * frame, producing the measured signature of six identical `GET /api/agents/:id`
 * requests inside 8ms and 3-6s response latencies.
 *
 * Two properties matter, and they pull in opposite directions:
 *
 * - An isolated event must still feel instant. A purely trailing debounce would
 *   delay every single update by the full window, which is a worse product than
 *   the storm it fixes.
 * - A burst must cost one flush, not one per frame.
 *
 * So the flush is leading-edge on a MICROTASK, then trailing-edge per window.
 * The microtask is load-bearing rather than incidental: one WS event handler
 * queues several keys synchronously (an agent's detail, the list prefix, the
 * action centre). A synchronous leading flush would emit the first key alone and
 * defer that event's remaining keys into the next window, tearing one logical
 * event across two refetch rounds. Deferring by a microtask lets the handler
 * finish queueing, so each event flushes as a unit.
 *
 * Keys are de-duplicated within a flush, so N events touching the same key cost
 * one invalidation regardless of N.
 *
 * The callback may return `'retry'` to say "I could not fully act on this key
 * yet" — the key is re-queued and offered again on the trailing window, until a
 * flush where the callback accepts it. The caller uses this to serialize
 * refetches per key: while a refetch is in flight it declines, and the retry
 * guarantees one fresh refetch after the in-flight one settles, so the final
 * state is never missed.
 */
export type CoalescedQueryKey = readonly unknown[]

export type InvalidationCoalescerOptions = {
  /**
   * Minimum spacing between flushes. 150ms is below the ~200ms threshold where
   * a UI update starts reading as lag, and comfortably above the sub-10ms
   * clustering the storm produced.
   */
  windowMs?: number
  /** Injected for deterministic tests; defaults to real timers. */
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancel?: (handle: ReturnType<typeof setTimeout>) => void
  /** Injected for deterministic tests; defaults to `queueMicrotask`. */
  scheduleMicrotask?: (callback: () => void) => void
}

export type InvalidationCoalescer = {
  queue: (queryKey: CoalescedQueryKey) => void
  /** Queue a concrete retry without treating the key as a descendant prefix. */
  queueExact: (queryKey: CoalescedQueryKey) => void
  dispose: () => void
}

export function createInvalidationCoalescer(
  invalidate: (queryKey: CoalescedQueryKey, exact: boolean) => void | 'retry',
  options: InvalidationCoalescerOptions = {}
): InvalidationCoalescer {
  const windowMs = options.windowMs ?? 150
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle))
  const scheduleMicrotask = options.scheduleMicrotask ?? queueMicrotask

  // Insertion-ordered so invalidations fire in the order the app asked for them;
  // the string key only de-duplicates. `hashKey` is React Query's own key hash —
  // it sorts object properties, so two logically identical filter objects
  // de-duplicate regardless of literal order, which `JSON.stringify` does not.
  const pending = new Map<string, { queryKey: CoalescedQueryKey; exact: boolean }>()
  let windowHandle: ReturnType<typeof setTimeout> | null = null
  let microtaskScheduled = false
  let disposed = false
  let flushing = false

  function addPending(queryKey: CoalescedQueryKey, exact: boolean) {
    const queryHash = hashKey(queryKey)
    for (const [hash, pendingEntry] of pending) {
      const pendingKey = pendingEntry.queryKey
      // A broad pending ancestor covers this key. A newly queued broad ancestor
      // replaces descendants, including exact retry work it will rediscover.
      if (!pendingEntry.exact && partialMatchKey(queryKey, pendingKey)) return
      if (!exact && partialMatchKey(pendingKey, queryKey)) pending.delete(hash)
      else if (exact && pendingEntry.exact && hash === queryHash) return
    }
    pending.set(queryHash, { queryKey, exact })
  }

  function flush() {
    if (pending.size === 0) return
    const entries = [...pending.values()]
    // Clear BEFORE invalidating: an invalidation can synchronously drive a
    // refetch whose handler queues more keys, and those belong to the next
    // flush rather than to the array being iterated here.
    pending.clear()
    // `pending` is not the only state a re-entrant queue can corrupt. Both call
    // sites of `flush` leave `windowHandle === null` while this loop runs, so a
    // synchronous re-queue would pass the open-window short-circuit, schedule
    // its own microtask, and call `openWindow` a second time — overwriting the
    // handle and orphaning the first timer, which `dispose` then cannot cancel.
    // Marking the flush closes that window.
    flushing = true
    try {
      for (const { queryKey, exact } of entries) {
        // A declined key goes back into `pending`, which was cleared above, so
        // the trailing window (both flush call sites open one right after this
        // returns) offers it again. Re-queuing joins any keys a re-entrant
        // handler queued mid-flush; the hash de-duplicates the two sources.
        if (invalidate(queryKey, exact) === 'retry') addPending(queryKey, exact)
      }
    } finally {
      flushing = false
    }
  }

  function openWindow() {
    windowHandle = schedule(() => {
      windowHandle = null
      if (disposed) return
      // Only keep the cadence alive while work keeps arriving — an idle
      // coalescer holds no timer, so it costs nothing between bursts.
      if (pending.size === 0) return
      flush()
      openWindow()
    }, windowMs)
  }

  function queuePending(queryKey: CoalescedQueryKey, exact: boolean) {
    if (disposed) return
    addPending(queryKey, exact)
    // A window is already open, or we are mid-flush and about to open one:
    // the trailing flush will collect this key.
    if (windowHandle !== null || flushing || microtaskScheduled) return
    microtaskScheduled = true
    scheduleMicrotask(() => {
      microtaskScheduled = false
      if (disposed) return
      flush()
      openWindow()
    })
  }

  return {
    queue: (queryKey) => queuePending(queryKey, false),
    queueExact: (queryKey) => queuePending(queryKey, true),
    dispose() {
      disposed = true
      if (windowHandle !== null) cancel(windowHandle)
      windowHandle = null
      pending.clear()
    },
  }
}
