export function uniqueRouteEndpoints(routes: Array<{ method: string; path: string }>) {
  return [
    ...new Map(
      routes
        .filter((route) => route.method.toUpperCase() !== 'HEAD')
        .map((route) => {
          const endpoint = { method: route.method.toUpperCase(), path: route.path }
          return [`${endpoint.method} ${endpoint.path}`, endpoint] as const
        })
    ).values(),
  ]
}

/** Drain all started probes, including when one fails; never leak into the next test. */
export async function probeWithConcurrency<T>(entries: T[], limit: number, probe: (entry: T) => Promise<void>) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid probe concurrency')
  let next = 0
  const errors: unknown[] = []
  await Promise.all(
    Array.from({ length: Math.min(limit, entries.length) }, async () => {
      while (!errors.length && next < entries.length) {
        const entry = entries[next++]!
        try {
          await probe(entry)
        } catch (error) {
          errors.push(error)
        }
      }
    })
  )
  if (errors.length) throw new AggregateError(errors, 'Route probe failed')
}
