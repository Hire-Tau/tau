/** Return whether an error is, or was caused by, a semantic abort signal. */
export function isMigrationCancellation(value: unknown): boolean {
  let current = value
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 8 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current)
    const error = current as { name?: unknown; code?: unknown; cause?: unknown }
    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return true
    current = error.cause
  }
  return false
}
