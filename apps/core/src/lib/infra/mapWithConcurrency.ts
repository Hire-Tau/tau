/**
 * Map `items` through `fn` with at most `concurrency` invocations in flight at
 * once. Results are returned in INPUT order (never completion order), so
 * callers may aggregate them without depending on which task finished first.
 *
 * A rejection from `fn` rejects the whole call (like `Promise.all`). Callers
 * that need per-item error isolation must catch inside `fn` — this keeps the
 * primitive dumb and the isolation policy explicit at the call site.
 *
 * `concurrency` is clamped to at least 1 (a non-positive cap runs serially).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R> | R
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency))
  const results = new Array<R>(items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}
