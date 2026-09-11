/** Startup only: never replay a model turn or an operation after settlement. */
export const STARTUP_RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const

// Preserve the original error type, cause, and admission identity. The runner
// marks only its setup catch; run() also awaits a model turn and can reject later.
const startupFailures = new WeakSet<Error>()
export function markExecutionStartupFailure<T>(error: T): T {
  if (error instanceof Error) startupFailures.add(error)
  return error
}
export function isExecutionStartupFailure(error: unknown): boolean {
  return error instanceof Error && startupFailures.has(error)
}

const DATABASE_CONNECTION_ERRORS = new Set([
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
])

/** Drizzle and admission effects can wrap the original database error. */
export function startupRetryCode(error: unknown): string | null {
  const seen = new Set<object>()
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error)
    const code = (error as Error & { code?: unknown }).code
    if (typeof code === 'string' && DATABASE_CONNECTION_ERRORS.has(code)) return code
    error = error.cause
  }
  return null
}
