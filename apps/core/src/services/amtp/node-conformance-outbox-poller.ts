export interface TestNodeOutboxRow {
  id: string
  status: 'delivered' | 'pending' | 'delivering' | 'failed'
  attempts: number
  lastError: string | null
}

const MAX_ERROR_DIAGNOSTIC_BYTES = 16_384
// Below this, process startup and opening the node's SQLite database cannot
// produce a useful conformance observation before the deadline.
const MIN_USEFUL_QUERY_BUDGET_MS = 100

interface PollTestNodeOutboxDeps {
  /** Must bound and clean up its subprocess within the supplied remaining deadline. */
  queryRows: (remainingMs: number, signal: AbortSignal) => Promise<TestNodeOutboxRow[]>
  sleep: (ms: number) => Promise<unknown>
  now: () => number
  intervalMs: number
  /** Smallest budget worth paying CLI startup and database-open costs. */
  minQueryBudgetMs?: number
  diagnostics: () => string
}

/** Waits for one exact node outbox row to reach the expected terminal failure. */
export async function pollTestNodeOutboxFailure(
  outboxId: string,
  phase: string,
  timeoutMs: number,
  deps: PollTestNodeOutboxDeps
): Promise<TestNodeOutboxRow> {
  const deadline = deps.now() + timeoutMs
  let lastRow: TestNodeOutboxRow | undefined
  let lastQueryFailure: string | undefined

  while (deps.now() < deadline) {
    const remainingBeforeQueryMs = deadline - deps.now()
    if (remainingBeforeQueryMs < (deps.minQueryBudgetMs ?? MIN_USEFUL_QUERY_BUDGET_MS)) break
    try {
      const queryController = new AbortController()
      const queryTimer = setTimeout(() => queryController.abort('outbox query deadline'), remainingBeforeQueryMs)
      try {
        const rows = await deps.queryRows(remainingBeforeQueryMs, queryController.signal)
        lastRow = rows.find((candidate) => candidate.id === outboxId)
        lastQueryFailure = undefined
      } finally {
        clearTimeout(queryTimer)
      }
    } catch (error) {
      lastQueryFailure = error instanceof Error ? error.message : String(error)
    }

    if (deps.now() >= deadline) break
    if (lastRow?.status === 'failed') return lastRow
    if (lastRow?.status === 'delivered') {
      throw new Error(
        `${phase} unexpectedly delivered; ${formatDiagnostics(lastRow, lastQueryFailure, deps.diagnostics())}`
      )
    }

    const remainingMs = deadline - deps.now()
    if (remainingMs > 0) await deps.sleep(Math.min(deps.intervalMs, remainingMs))
  }

  throw new Error(
    `${phase} timed out after ${timeoutMs}ms; ${formatDiagnostics(lastRow, lastQueryFailure, deps.diagnostics())}`
  )
}

/** Test-only conformance helper that polls a node CLI outbox without treating transient query failures as delivery failures. */
export async function pollTestNodeOutboxDelivery(
  outboxId: string,
  phase: string,
  timeoutMs: number,
  deps: PollTestNodeOutboxDeps
): Promise<void> {
  const deadline = deps.now() + timeoutMs
  let lastRow: TestNodeOutboxRow | undefined
  let lastQueryFailure: string | undefined

  while (deps.now() < deadline) {
    const remainingBeforeQueryMs = deadline - deps.now()
    if (remainingBeforeQueryMs < (deps.minQueryBudgetMs ?? MIN_USEFUL_QUERY_BUDGET_MS)) break

    try {
      const queryController = new AbortController()
      const queryTimer = setTimeout(() => queryController.abort('outbox query deadline'), remainingBeforeQueryMs)
      try {
        const rows = await deps.queryRows(remainingBeforeQueryMs, queryController.signal)
        lastRow = rows.find((candidate) => candidate.id === outboxId)
      } finally {
        clearTimeout(queryTimer)
      }
    } catch (error) {
      lastQueryFailure = error instanceof Error ? error.message : String(error)
    }

    // Never accept a result that completed after the overall protocol budget.
    if (deps.now() >= deadline) break
    if (lastRow?.status === 'delivered') return
    if (lastRow?.status === 'failed') {
      throw new Error(
        `${phase} delivery failed after ${lastRow.attempts} attempt(s): ${boundError(lastRow.lastError ?? 'unknown error')}; ${formatDiagnostics(lastRow, lastQueryFailure, deps.diagnostics())}`
      )
    }

    const remainingMs = deadline - deps.now()
    if (remainingMs > 0) await deps.sleep(Math.min(deps.intervalMs, remainingMs))
  }

  throw new Error(
    `${phase} timed out after ${timeoutMs}ms; ${formatDiagnostics(lastRow, lastQueryFailure, deps.diagnostics())}`
  )
}

function formatDiagnostics(
  lastRow: TestNodeOutboxRow | undefined,
  lastQueryFailure: string | undefined,
  extra: string
): string {
  const boundedRow = lastRow
    ? { ...lastRow, lastError: lastRow.lastError ? boundError(lastRow.lastError) : null }
    : null
  return [
    lastQueryFailure ? `last outbox query failure=${boundError(lastQueryFailure)}` : '',
    `last outbox row=${JSON.stringify(boundedRow)}`,
    extra,
  ]
    .filter(Boolean)
    .join('; ')
}

function boundError(value: string): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= MAX_ERROR_DIAGNOSTIC_BYTES) return value
  // Reserve enough bytes for the ellipsis and a replacement character if the
  // tail begins in the middle of a multi-byte code point.
  const tail = bytes.slice(-(MAX_ERROR_DIAGNOSTIC_BYTES - 6))
  return `…${new TextDecoder().decode(tail)}`
}
