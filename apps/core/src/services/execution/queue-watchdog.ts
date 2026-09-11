import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, executions } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { Execution } from '../../entities/Execution'
import { createLogger } from '../../lib/infra/logger'
import {
  getActiveSessionCount,
  isSessionActive,
  isSessionReserved,
  isTransitionalOperationInProgress,
} from './session-state'
import { attemptPickup } from './pickup'
import { maintenanceStore } from '../maintenance/store'

const log = createLogger('queue-watchdog')

export const QUEUE_STALL_WARNING_MS = 60_000
export const STUCK_TRANSITIONAL_MS = 3 * 60_000

/**
 * Periodic sweep cadence for the watchdog. This is the watchdog's own
 * concept — worker.ts's periodic runner imports it directly rather than
 * keeping a second, independently-drifting copy of the number.
 */
export const WATCHDOG_INTERVAL_MS = 30_000

/**
 * How long a `running` execution may go without a local session or session
 * reservation before it's considered orphaned (narrow reserveSession-after-CAS
 * race in `Execution.run()`: the queued->running CAS wins but reserveSession
 * then loses, leaving the row `running` with a leaked provider slot, the
 * agent `active`, and no runner). Generous default — normal pickup reserves
 * the session within milliseconds of the CAS, so anything still sessionless
 * at this age is stuck, not just slow.
 */
export const ORPHANED_RUNNING_THRESHOLD_MS = Number(process.env.ORPHANED_RUNNING_THRESHOLD_MS) || 120_000

export interface QueueWatchdogOptions {
  now?: number
  stallMs?: number
  stuckMs?: number
  orphanedRunningMs?: number
  watchdogIntervalMs?: number
}

export async function runQueueWatchdogOnce(opts: QueueWatchdogOptions = {}): Promise<void> {
  const now = opts.now ?? Date.now()
  const stallMs = opts.stallMs ?? QUEUE_STALL_WARNING_MS
  const stuckMs = opts.stuckMs ?? STUCK_TRANSITIONAL_MS
  const orphanedRunningMs = opts.orphanedRunningMs ?? ORPHANED_RUNNING_THRESHOLD_MS
  const watchdogIntervalMs = opts.watchdogIntervalMs ?? WATCHDOG_INTERVAL_MS

  try {
    await recoverStuckTransitionalAgents(now, stuckMs)
    if (!maintenanceStore.isPausedCached(new Date(now))) await nudgeStalledQueuedExecutions(now, stallMs)
    await requeueOrphanedRunningExecutions(now, orphanedRunningMs, watchdogIntervalMs)
    await reportSessionLeakIfAny()
  } catch (err) {
    log.error('Watchdog pass failed:', err)
  }
}

async function recoverStuckTransitionalAgents(now: number, stuckMs: number): Promise<void> {
  const stuckRows = await db
    .select({ id: agents.id, status: agents.status, updatedAt: agents.updatedAt })
    .from(agents)
    .where(
      and(inArray(agents.status, ['compacting', 'resetting'] as const), lt(agents.updatedAt, new Date(now - stuckMs)))
    )

  for (const row of stuckRows) {
    if (isTransitionalOperationInProgress(row.id)) {
      log.info(`Skipping stuck-${row.status} recovery for agent ${row.id} (operation in flight here)`)
      continue
    }

    const agent = await Agent.find(row.id)
    if (!agent || agent.status !== row.status) continue

    log.warn(`Recovering agent ${row.id} stuck in ${row.status} since ${row.updatedAt.toISOString()}`)
    try {
      if (row.status === 'compacting') {
        await agent.finishCompaction()
      } else {
        await agent.finishReset()
      }
    } catch (err) {
      log.error(`Failed to recover stuck ${row.status} agent ${row.id}:`, err)
    }
  }
}

async function nudgeStalledQueuedExecutions(now: number, stallMs: number): Promise<void> {
  const stalled = await db
    .select({ id: executions.id, agentId: executions.agentId, startedAt: executions.startedAt })
    .from(executions)
    .where(and(eq(executions.status, 'queued'), lt(executions.startedAt, new Date(now - stallMs))))

  for (const row of stalled) {
    log.warn(
      `Stalled queued execution ${row.id} (agent ${row.agentId}) — queued since ${row.startedAt.toISOString()}; nudging directly`
    )
    const exec = await Execution.find(row.id)
    if (exec) await attemptPickup(exec)
  }
}

/**
 * First-detection timestamp (the `now` of the sweep that first saw it
 * sessionless) for each execution id currently suspected orphaned. Entries
 * are removed as soon as a row stops looking orphaned (session appears, the
 * row leaves `running`, or it's gone) or once it's actually requeued — see
 * `requeueOrphanedRunningExecutions` — so this never grows unboundedly.
 */
const orphanCandidates: Map<string, number> = new Map()

/**
 * Sweep `running` executions whose agent has no local session and no session
 * reservation past `orphanedRunningMs`, and requeue them.
 *
 * Age is measured off `startedAt` — the only timestamp the `executions` row
 * carries. It's set once at row creation (`defaultNow()`) and is untouched by
 * the queued->running CAS in `Execution.transitionTo({kind:'started'})`, so
 * it isn't a true "entered running" timestamp — it's really "created at,"
 * which for a *starved* execution (queued a long time before finally being
 * picked up) can already be older than `orphanedRunningMs` the instant it
 * starts running. Age alone therefore can't tell a genuinely-stuck orphan
 * apart from a healthy execution that just this moment reserved its session
 * (`reserveSession` runs in the same synchronous stretch of `run()` as the
 * CAS, but with a real DB round-trip — `finishAgentWrite` — in between, so
 * "milliseconds away" is a real window, not a rounding error).
 *
 * So this requires TWO sweeps to agree before acting: a row must show up
 * sessionless on one sweep (recorded in `orphanCandidates`, not touched) and
 * again on a later sweep at least `watchdogIntervalMs` after the first
 * (confirmed, then requeued). A healthy execution cannot stay sessionless
 * across two whole sweep intervals — reserveSession succeeds within the same
 * pickup macrotask chain, long before the next sweep runs — so this only
 * delays, never suppresses, detection of a real orphan.
 *
 * (We don't add a dedicated "entered running" schema column for this — no
 * migration in what's meant to be a pure refactor PR — and `startedAt`'s
 * "created at" semantics are pre-existing/relied-upon elsewhere, so it isn't
 * touched either.)
 *
 * Single-worker invariant: this arm assumes exactly one worker process is
 * running the queue. It requeues any `running` row whose agent has no LOCAL
 * session or reservation (`isSessionActive`/`isSessionReserved` only see
 * this process's in-memory maps) — with a second worker, one process's
 * healthy, actively-running executions would look sessionless to the other
 * and get requeued out from under it. This matches the per-process
 * `concurrencyLimiter` and `session-state` module, which are both
 * in-memory and process-local by the same assumption.
 */
async function requeueOrphanedRunningExecutions(
  now: number,
  orphanedRunningMs: number,
  watchdogIntervalMs: number
): Promise<void> {
  const orphaned = await db
    .select({ id: executions.id, agentId: executions.agentId, startedAt: executions.startedAt })
    .from(executions)
    .where(and(eq(executions.status, 'running'), lt(executions.startedAt, new Date(now - orphanedRunningMs))))

  const stillOrphaned = new Set<string>()

  for (const row of orphaned) {
    if (isSessionActive(row.agentId) || isSessionReserved(row.agentId)) continue

    stillOrphaned.add(row.id)

    const firstSeen = orphanCandidates.get(row.id)
    if (firstSeen === undefined) {
      orphanCandidates.set(row.id, now)
      log.info(
        `Orphan candidate: running execution ${row.id} (agent ${row.agentId}) — running since ${row.startedAt.toISOString()} with no session/reservation; awaiting confirmation sweep`
      )
      continue
    }

    if (now - firstSeen < watchdogIntervalMs) continue // not confirmed across a second sweep yet

    // Confirmed orphaned across two sweeps. Re-verify immediately before
    // writing: a session may have appeared (and even finished) since the
    // select above, or since it was first flagged. transitionTo({requeued})'s
    // own tx write is the final guard regardless, but this cheap re-check
    // keeps the warn log (and the requeue itself) free of false positives.
    const exec = await Execution.find(row.id)
    if (!exec || exec.status !== 'running' || isSessionActive(row.agentId) || isSessionReserved(row.agentId)) {
      orphanCandidates.delete(row.id)
      continue
    }

    log.warn(
      `Orphaned running execution ${row.id} (agent ${row.agentId}) — running since ${row.startedAt.toISOString()} with no session/reservation across two sweeps; requeueing`
    )
    // Safe to requeue directly here (no hot loop): the agent has no active or
    // reserved session, so the execution.queued emit this triggers hands the
    // row to the normal pickup path instead of colliding with a still-live
    // session (the hazard the reserveSession-failure-site inline fix would
    // have hit).
    await exec.transitionTo({ kind: 'requeued' })
    orphanCandidates.delete(row.id)
  }

  // Prune candidates that no longer look orphaned this sweep (session
  // appeared, the row left `running`, or it's gone entirely) so the map
  // tracks only what's currently suspect.
  for (const id of orphanCandidates.keys()) {
    if (!stillOrphaned.has(id)) orphanCandidates.delete(id)
  }
}

async function reportSessionLeakIfAny(): Promise<void> {
  const active = getActiveSessionCount()
  if (active === 0) return

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(executions)
    .where(eq(executions.status, 'running'))

  if (active > count) {
    log.error(
      `Session leak suspected: in-memory active=${active}, DB running=${count}. Worker may be over-counting capacity.`
    )
  }
}
