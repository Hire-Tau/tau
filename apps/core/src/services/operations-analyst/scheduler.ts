import { and, asc, eq, gte, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { executions, operationsExecutionAnalyses } from '../../db/schema'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { analyzeExecution } from './analyzer'

export const OPERATIONS_ANALYST_INTERVAL_MS = 60_000
export const OPERATIONS_ANALYST_BATCH_SIZE = 25
export const OPERATIONS_ANALYST_BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60_000
/**
 * How far back a drained sweep keeps re-scanning. Must comfortably exceed the
 * longest an execution can stay `running` — an execution that starts before the
 * cursor and only completes after it is the sole way the cursor can skip work,
 * and the abandoned-lease watchdog requeues or fails a stalled execution long
 * before a day is out.
 */
export const OPERATIONS_ANALYST_RESCAN_OVERLAP_MS = 24 * 60 * 60_000
const log = createLogger('operations-analyst')
let runner: PeriodicRunner | null = null
let unsubscribe: (() => void) | null = null
let sweeping = false

/**
 * Sweep cursor. The 30-day anti-join used to run unconditionally every 60s even
 * at zero backlog; the cursor keeps a floor to scan forward from instead.
 *
 * Invariant: `scanFloorMs` is only ever advanced to `now - RESCAN_OVERLAP` and
 * only by a sweep that (a) came back short of a full batch — so it enumerated
 * every completed-and-unanalysed execution at or after the previous floor — and
 * (b) analysed every id it enumerated without a failure. A full batch means
 * there is still a backlog, and a failed analysis means an enumerated row is
 * still pending, so in both cases the floor stays where it is and the next tick
 * re-scans the same range. It never moves backwards and never drops below the
 * 30-day retention window.
 *
 * It is deliberately NOT seeded from the newest analysed row on boot: a process
 * that was down while executions piled up would then start its cursor past the
 * whole backlog. Starting at the retention floor costs one full scan per process
 * lifetime and cannot skip anything.
 */
let scanFloorMs: number | null = null

/** The `startedAt` floor the next backfill scan will use. */
export function operationsAnalystScanFloor(now: Date = new Date()): Date {
  const retentionFloorMs = now.getTime() - OPERATIONS_ANALYST_BACKFILL_WINDOW_MS
  return new Date(Math.max(retentionFloorMs, scanFloorMs ?? retentionFloorMs))
}

/** Drops the cursor back to the retention window — used on stop and by tests. */
export function resetOperationsAnalystScanFloor(): void {
  scanFloorMs = null
}

function advanceOperationsAnalystScanFloor(now: Date, drained: boolean): void {
  if (!drained) return
  const candidate = now.getTime() - OPERATIONS_ANALYST_RESCAN_OVERLAP_MS
  scanFloorMs = scanFloorMs === null ? candidate : Math.max(scanFloorMs, candidate)
}

/**
 * The sweep's backfill query. Exported so its bounds — completed-only, the
 * `startedAt` floor, the not-yet-analysed anti-join, and the ascending batch
 * limit — can be asserted against a real Postgres. Every one of them was
 * deletable without turning a test red before scheduler.test.ts covered this.
 */
export async function loadPendingOperationsAnalyses(now: Date = new Date()): Promise<string[]> {
  const rows = await db
    .select({ id: executions.id })
    .from(executions)
    .leftJoin(operationsExecutionAnalyses, eq(executions.id, operationsExecutionAnalyses.executionId))
    .where(
      and(
        eq(executions.status, 'completed'),
        gte(executions.startedAt, operationsAnalystScanFloor(now)),
        isNull(operationsExecutionAnalyses.executionId)
      )
    )
    .orderBy(asc(executions.startedAt))
    .limit(OPERATIONS_ANALYST_BATCH_SIZE)
  return rows.map((row) => row.id)
}
export async function runOperationsAnalysisSweepOnce(
  deps: {
    loadPending?: () => Promise<string[]>
    analyze?: typeof analyzeExecution
    logFailure?: (executionId: string) => void
    now?: Date
  } = {}
): Promise<number> {
  if (sweeping) return 0
  sweeping = true
  try {
    const now = deps.now ?? new Date()
    const enumerated = await (deps.loadPending ?? (() => loadPendingOperationsAnalyses(now)))()
    const ids = enumerated.slice(0, OPERATIONS_ANALYST_BATCH_SIZE)
    let count = 0
    let failures = 0
    for (const id of ids) {
      try {
        if ((await (deps.analyze ?? analyzeExecution)(id)) !== 'already-analyzed') count++
      } catch {
        failures += 1
        ;(deps.logFailure ?? ((executionId) => log.warn(`analysis failed for execution ${executionId}`)))(id)
      }
    }
    advanceOperationsAnalystScanFloor(now, enumerated.length < OPERATIONS_ANALYST_BATCH_SIZE && failures === 0)
    return count
  } finally {
    sweeping = false
  }
}
export function startOperationsAnalyst(): void {
  if (runner) return
  unsubscribe = eventEmitter.on('execution.completed', ({ executionId }) => {
    void analyzeExecution(executionId).catch(() => log.warn(`analysis failed for execution ${executionId}`))
  })
  runner = createPeriodicRunner({
    name: 'operations-analyst',
    intervalMs: OPERATIONS_ANALYST_INTERVAL_MS,
    runImmediately: true,
    task: async () => {
      await runOperationsAnalysisSweepOnce()
    },
  })
  runner.start()
}
export async function stopOperationsAnalyst(): Promise<void> {
  unsubscribe?.()
  unsubscribe = null
  if (runner) await runner.stop()
  runner = null
  // A restarted analyst re-backfills the whole retention window once.
  resetOperationsAnalystScanFloor()
}
