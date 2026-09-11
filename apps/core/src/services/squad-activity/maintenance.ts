import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { activityRetentionFloor } from '../squad/activity-cursor'
import { repairSquadActivity, type RepairReport, validateRepairWindow } from './repair'
import { ActivityMaintenanceLeaseLostError } from './lease'
export { ActivityMaintenanceLeaseLostError } from './lease'

const log = createLogger('squad-activity-maintenance')

/**
 * How often the worker's convergence sweep runs. Live rows are materialized
 * event-driven at write time; this sweep only repairs what those events
 * missed (crashes, bugs, delayed webhooks), so its cadence bounds how stale a
 * MISSED row can get — not feed freshness. Hourly instead of the original 15
 * minutes: each tick re-diffs the whole 48h window (hundreds of per-group
 * transactions on the shared tenant cluster), and 96 sweeps/day of that was
 * measurable read load for no convergence benefit.
 */
export const REPAIR_INTERVAL_MS = 60 * 60_000
/**
 * Lease duration + heartbeat base, decoupled from the sweep interval so a
 * crashed holder blocks the next repair (manual or periodic) for at most 15
 * minutes — not a whole sweep interval.
 */
export const REPAIR_LEASE_MS = 15 * 60_000
export const ACTIVITY_REPAIR_LEASE_TASK = 'repair'
export const REPAIR_WINDOW_MS = 48 * 60 * 60_000
/**
 * How often the sweep pays for the WHOLE 48h window plus the projection
 * anti-join pass. Every other tick scans only what changed since the last one:
 * each family's source page is selected by an event-facet timestamp inside the
 * window (message created_at, execution run_started_at/ended_at, wait
 * opened_at/closed_at, inbox created_at, work-stream created_at), so any group
 * that gained or changed a facet re-enters the window on its own. Only deletes
 * and reassociations — which produce no facet — need the full pass, and those
 * converge here, daily, instead of costing a full re-diff every hour.
 */
export const REPAIR_FULL_INTERVAL_MS = 24 * 60 * 60_000
/**
 * How far before the last scan watermark an incremental sweep restarts.
 * Covers clock skew between workers and the live path's publishAfter delay, so
 * a facet written moments before the previous scan boundary is still seen.
 */
export const REPAIR_INCREMENTAL_OVERLAP_MS = 15 * 60_000
export const REPAIR_LIVE_PUBLISH_MS = 5 * 60_000
export const RETENTION_DAYS = 30
export const PRUNE_INTERVAL_MS = 60 * 60_000
export const PRUNE_BATCH_SIZE = 1_000
export const PRUNE_MAX_BATCHES = 5

export async function activityDatabaseNow(): Promise<Date> {
  const [row] = await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() now`)
  return new Date(row.now)
}

async function acquireLease(task: string, durationMs: number): Promise<string | null> {
  const token = randomUUID()
  const rows =
    await db.execute<any>(sql`INSERT INTO squad_activity_maintenance_leases(task,lease_token,lease_until,updated_at)
    VALUES(${task},${token}::uuid,clock_timestamp()+(${durationMs}*interval '1 millisecond'),clock_timestamp())
    ON CONFLICT(task) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until,updated_at=excluded.updated_at
    WHERE squad_activity_maintenance_leases.lease_until<=clock_timestamp() RETURNING lease_token`)
  return rows[0]?.lease_token ?? null
}

async function renewLease(task: string, token: string, durationMs: number): Promise<void> {
  const rows = await db.execute<any>(sql`UPDATE squad_activity_maintenance_leases
    SET lease_until=clock_timestamp()+(${durationMs}*interval '1 millisecond'),updated_at=clock_timestamp()
    WHERE task=${task} AND lease_token=${token}::uuid AND lease_until>clock_timestamp() RETURNING lease_token`)
  if (!rows[0]) throw new ActivityMaintenanceLeaseLostError(`Activity ${task} lease lost`)
}

export async function releaseActivityMaintenanceLease(task: string, token: string): Promise<void> {
  const rows = await db.execute<any>(sql`DELETE FROM squad_activity_maintenance_leases
    WHERE task=${task} AND lease_token=${token}::uuid AND lease_until>clock_timestamp() RETURNING lease_token`)
  if (!rows[0]) throw new ActivityMaintenanceLeaseLostError(`Activity ${task} lease lost before release`)
}

export interface LeasedActivityRepairInput {
  from: Date
  to: Date
  task?: string
  publishAfter?: Date
  pageSize?: number
  concurrency?: number
  signal?: AbortSignal
  scanTo?: Date
  projectionPass?: boolean
}

export async function runLeasedActivityRepair(input: LeasedActivityRepairInput): Promise<RepairReport | null> {
  validateRepairWindow(input)
  if (input.task !== undefined && input.task !== ACTIVITY_REPAIR_LEASE_TASK)
    throw new TypeError('Activity repair must use the shared repair lease')
  const task = ACTIVITY_REPAIR_LEASE_TASK
  const token = await acquireLease(task, REPAIR_LEASE_MS)
  if (!token) return null
  let heartbeatError: unknown = null
  let heartbeat: Promise<void> | null = null
  const beat = () => {
    if (heartbeat) return
    heartbeat = renewLease(task, token, REPAIR_LEASE_MS)
      .catch((error) => {
        heartbeatError = error
      })
      .finally(() => {
        heartbeat = null
      })
  }
  const timer = setInterval(beat, Math.floor(REPAIR_LEASE_MS / 3))
  const assertLease = async () => {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error('Activity repair aborted')
    if (heartbeatError) throw heartbeatError
    if (heartbeat) await heartbeat
    await renewLease(task, token, REPAIR_LEASE_MS)
  }
  try {
    await assertLease()
    const report = await repairSquadActivity({
      from: input.from,
      to: input.to,
      pageSize: input.pageSize,
      concurrency: input.concurrency,
      publishAfter: input.publishAfter,
      scanTo: input.scanTo,
      projectionPass: input.projectionPass,
      assertLease,
      leaseFence: { task, token },
    })
    await assertLease()
    return report
  } finally {
    clearInterval(timer)
    if (heartbeat) await heartbeat
    await releaseActivityMaintenanceLease(task, token)
  }
}

export interface ActivityRepairWatermarks {
  /** Upper scan boundary of the last error-free sweep of any kind. */
  lastIncrementalScanTo: Date | null
  /** Upper scan boundary of the last error-free FULL-window sweep. */
  lastFullScanTo: Date | null
}

export async function readActivityRepairWatermarks(): Promise<ActivityRepairWatermarks> {
  const rows = await db.execute<any>(sql`SELECT last_incremental_scan_to,last_full_scan_to
    FROM squad_activity_maintenance_leases WHERE task=${ACTIVITY_REPAIR_LEASE_TASK}`)
  const row = rows[0]
  return {
    lastIncrementalScanTo: row?.last_incremental_scan_to ? new Date(row.last_incremental_scan_to) : null,
    lastFullScanTo: row?.last_full_scan_to ? new Date(row.last_full_scan_to) : null,
  }
}

/**
 * Advance the watermarks after an error-free sweep. Single statement, outside
 * any repair transaction, and deliberately an upsert: releasing the lease
 * DELETES the row, so the watermarks have to be able to recreate it. The
 * recreated row carries an already-expired lease so it can never block the next
 * acquisition, and GREATEST keeps a slower concurrent sweep from rewinding a
 * watermark another worker already advanced.
 */
async function advanceActivityRepairWatermarks(scanTo: Date, full: boolean): Promise<void> {
  const fullScanTo = full ? scanTo.toISOString() : null
  await db.execute(sql`INSERT INTO squad_activity_maintenance_leases
    (task,lease_token,lease_until,updated_at,last_incremental_scan_to,last_full_scan_to)
    VALUES(${ACTIVITY_REPAIR_LEASE_TASK},gen_random_uuid(),clock_timestamp(),clock_timestamp(),
      ${scanTo.toISOString()}::timestamptz,${fullScanTo}::timestamptz)
    ON CONFLICT(task) DO UPDATE SET
      last_incremental_scan_to=GREATEST(squad_activity_maintenance_leases.last_incremental_scan_to,excluded.last_incremental_scan_to),
      last_full_scan_to=GREATEST(squad_activity_maintenance_leases.last_full_scan_to,excluded.last_full_scan_to),
      updated_at=clock_timestamp()`)
}

export async function runActivityRepair(
  deps: {
    now?: () => Promise<Date>
    run?: (input: LeasedActivityRepairInput) => Promise<RepairReport | null>
  } = {}
): Promise<RepairReport | null> {
  const now = await (deps.now ?? activityDatabaseNow)()
  const watermarks = await readActivityRepairWatermarks()
  // Full when nothing has ever been scanned, or the daily full pass is due.
  const full =
    watermarks.lastIncrementalScanTo === null ||
    watermarks.lastFullScanTo === null ||
    now.getTime() - watermarks.lastFullScanTo.getTime() >= REPAIR_FULL_INTERVAL_MS
  const windowFloor = now.getTime() - REPAIR_WINDOW_MS
  // The upper clamp is not cosmetic: validateRepairWindow requires from < to,
  // so a watermark at (or ahead of) `now` — clock skew, a manual repair — must
  // still leave a non-empty window.
  const from = full
    ? new Date(windowFloor)
    : new Date(
        Math.min(
          Math.max(windowFloor, watermarks.lastIncrementalScanTo!.getTime() - REPAIR_INCREMENTAL_OVERLAP_MS),
          now.getTime() - REPAIR_INCREMENTAL_OVERLAP_MS
        )
      )
  const report = await (deps.run ?? runLeasedActivityRepair)({
    from,
    to: now,
    publishAfter: new Date(now.getTime() - REPAIR_LIVE_PUBLISH_MS),
    scanTo: now,
    projectionPass: full,
  })
  if (!report) return null
  // Only an error-free sweep may advance: on errors the next tick re-covers
  // exactly the same range.
  if (report.errors === 0) await advanceActivityRepairWatermarks(now, full)
  log.info(
    `Activity repair ${full ? 'full' : 'incremental'} sweep ${from.toISOString()}..${now.toISOString()}: ` +
      `${report.groups} groups, ${report.changed} changed, ${report.errors} errors in ${report.elapsedMs}ms`
  )
  return report
}

export async function runActivityRepairTick(
  repair: () => Promise<RepairReport | null> = runActivityRepair
): Promise<void> {
  const report = await repair()
  if (!report || report.errors === 0) return
  const familyErrors = Object.fromEntries(
    Object.entries(report.families)
      .filter(([, family]) => family.errors > 0)
      .map(([family, detail]) => [family, detail.errors])
  )
  throw new Error(`Activity repair partial failure: ${report.errors} errors ${JSON.stringify(familyErrors)}`)
}

export async function pruneSquadActivity(): Promise<number> {
  const token = await acquireLease('prune', PRUNE_INTERVAL_MS)
  if (!token) return 0
  let count = 0
  try {
    const floor = activityRetentionFloor(await activityDatabaseNow())
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
      await renewLease('prune', token, PRUNE_INTERVAL_MS)
      const deleted = await db.transaction(async (tx) => {
        const fenced = await tx.execute<any>(sql`SELECT lease_token FROM squad_activity_maintenance_leases
          WHERE task='prune' AND lease_token=${token}::uuid AND lease_until>clock_timestamp() FOR SHARE`)
        if (!fenced[0]) throw new ActivityMaintenanceLeaseLostError('Activity prune lease lost')
        return tx.execute<any>(sql`WITH victims AS (
          SELECT squad_id,lane,row_id FROM squad_activity WHERE at<${floor.toISOString()}::timestamptz
          ORDER BY at,squad_id,lane,row_id FOR UPDATE SKIP LOCKED LIMIT ${PRUNE_BATCH_SIZE}
        ) DELETE FROM squad_activity a USING victims v
          WHERE (a.squad_id,a.lane,a.row_id)=(v.squad_id,v.lane,v.row_id) RETURNING a.row_id`)
      })
      count += deleted.length
      if (deleted.length < PRUNE_BATCH_SIZE) break
    }
    return count
  } finally {
    await releaseActivityMaintenanceLease('prune', token)
  }
}
