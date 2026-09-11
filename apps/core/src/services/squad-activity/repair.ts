import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { getPoolMax } from '../../db/connection'
import { createLogger } from '../../lib/infra/logger'
import { activityRetentionFloor } from '../squad/activity-cursor'
import { ActivityMaintenanceLeaseLostError, type ActivityMaintenanceLeaseFence } from './lease'
import { materializeSourceGroup } from './materialize'
import { ACTIVITY_SOURCE_FAMILIES, activityFamily, listSourceGroupPage } from './families'
import { listProjectedSourceGroupPage, type SourceGroupCursor } from './source-loaders'
import type { SquadActivitySourceFamily } from './types'
export { ACTIVITY_SOURCE_FAMILIES } from './families'

export interface RepairSquadActivityInput {
  from: Date
  to: Date
  pageSize?: number
  concurrency?: number
  publishAfter?: Date
  /** Frozen upper receipt boundary used only for delayed webhook candidate scanning. */
  scanTo?: Date
  /**
   * Run the projection anti-join pass (default). Set false to repair only the
   * source-scan side: every insert/update reaches its group through an event
   * facet inside the window, but a DELETE or reassociation produces no facet,
   * so only this pass can find it. Skipping it is safe ONLY for a sweep whose
   * missed deletes are covered by a later pass over the full window.
   */
  projectionPass?: boolean
  assertLease?: () => Promise<void>
  leaseFence?: ActivityMaintenanceLeaseFence
}
export interface RepairFailureDetail {
  phase: 'source-page' | 'projection-page' | 'materialize'
  groupId?: string
  cursor?: string
  message: string
}
export interface FamilyRepairReport {
  pages: number
  groups: number
  changed: number
  inserted: number
  updated: number
  deleted: number
  errors: number
  /** Wall-clock spent repairing this family, for load attribution. */
  elapsedMs: number
  failures: RepairFailureDetail[]
}
export interface RepairReport {
  groups: number
  elapsedMs: number
  changed: number
  inserted: number
  updated: number
  deleted: number
  errors: number
  families: Record<SquadActivitySourceFamily, FamilyRepairReport>
}
const log = createLogger('squad-activity-repair')
const MAX_FAILURE_DETAILS_PER_FAMILY = 10

/**
 * Default per-family materialize concurrency. Each in-flight group holds one
 * pool connection for the whole materialize transaction, so this MUST stay
 * strictly below the pool max: at the original hardcoded 4 (== the default
 * pool), a repair pass owned the entire pool and every other subsystem's
 * queries queued behind it — 30s of that trips the db liveness watchdog into
 * a pool swap (observed live on the noah tenant as a worker crash loop).
 * Leave at least 2 connections for the rest of the process.
 */
export function defaultRepairConcurrency(): number {
  return Math.max(1, Math.min(4, getPoolMax() - 2))
}

export function validateRepairWindow(input: RepairSquadActivityInput): void {
  const page = input.pageSize ?? 250
  const concurrency = input.concurrency ?? defaultRepairConcurrency()
  if (
    !Number.isFinite(input.from.valueOf()) ||
    !Number.isFinite(input.to.valueOf()) ||
    (input.publishAfter !== undefined && !Number.isFinite(input.publishAfter.valueOf())) ||
    (input.scanTo !== undefined && !Number.isFinite(input.scanTo.valueOf())) ||
    input.from >= input.to ||
    input.to.getTime() - input.from.getTime() > 30 * 86_400_000 ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 500 ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 16
  )
    throw new TypeError('Invalid Activity repair window')
}

function recordFailure(
  family: SquadActivitySourceFamily,
  report: FamilyRepairReport,
  detail: Omit<RepairFailureDetail, 'message'>,
  error: unknown
): void {
  report.errors++
  if (report.failures.length >= MAX_FAILURE_DETAILS_PER_FAMILY) return
  const failure = { ...detail, message: error instanceof Error ? error.message : String(error) }
  report.failures.push(failure)
  log.error('Activity repair partial failure', { family, ...failure, error })
}

async function settleGroups(
  family: SquadActivitySourceFamily,
  groupIds: string[],
  input: RepairSquadActivityInput,
  report: FamilyRepairReport
): Promise<void> {
  const concurrency = input.concurrency ?? defaultRepairConcurrency()
  for (let offset = 0; offset < groupIds.length; offset += concurrency) {
    await input.assertLease?.()
    const batch = groupIds.slice(offset, offset + concurrency)
    const results = await Promise.allSettled(
      batch.map((groupId) =>
        materializeSourceGroup(
          { family, groupId },
          {
            writeWindow: { from: input.from, to: input.to },
            publishAfter: input.publishAfter,
            publish: input.publishAfter !== undefined,
            leaseFence: input.leaseFence,
          }
        )
      )
    )
    const leaseFailure = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected' && result.reason instanceof ActivityMaintenanceLeaseLostError
    )
    if (leaseFailure) throw leaseFailure.reason
    for (const [index, result] of results.entries()) {
      report.groups++
      if (result.status === 'rejected')
        recordFailure(family, report, { phase: 'materialize', groupId: batch[index] }, result.reason)
      else {
        report.inserted += result.value.inserted.length
        report.updated += result.value.updated.length
        report.deleted += result.value.deleted.length
        report.changed += result.value.upserted.length + result.value.deleted.length
      }
    }
  }
}

async function repairFamily(
  family: SquadActivitySourceFamily,
  input: RepairSquadActivityInput,
  report: FamilyRepairReport
): Promise<void> {
  const pageSize = input.pageSize ?? 250
  let sourceCursor: SourceGroupCursor | null = null
  do {
    await input.assertLease?.()
    let page
    try {
      page = await listSourceGroupPage(family, input.from, input.to, sourceCursor, pageSize, input.scanTo)
    } catch (error) {
      recordFailure(family, report, { phase: 'source-page', cursor: sourceCursor?.id }, error)
      return
    }
    report.pages++
    await settleGroups(family, page.groupIds, input, report)
    sourceCursor = page.next
  } while (sourceCursor)

  // Append-only families are immutable receipts: no updates, no deletes, so
  // the projection anti-join pass has nothing to repair.
  if (activityFamily(family).appendOnly) return
  // Caller opted out (incremental sweep): re-reading every retained projection
  // group is the expensive half, and it only ever finds facet-less drift.
  if (input.projectionPass === false) return

  // Reload every retained projection group in the repair window. Missing durable
  // sources extract to an empty set, deleting stale non-PR facets. This is the
  // bounded anti-join path for missed deletes and reassociations.
  let projectionCursor: string | null = null
  do {
    await input.assertLease?.()
    let page
    try {
      page = await listProjectedSourceGroupPage(family, input.from, input.to, projectionCursor, pageSize)
    } catch (error) {
      recordFailure(family, report, { phase: 'projection-page', cursor: projectionCursor ?? undefined }, error)
      return
    }
    report.pages++
    await settleGroups(family, page.groupIds, input, report)
    projectionCursor = page.next
  } while (projectionCursor)
}

export async function repairSquadActivity(input: RepairSquadActivityInput): Promise<RepairReport> {
  validateRepairWindow(input)
  const databaseNow = new Date((await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() now`))[0].now)
  const scanTo = input.scanTo && input.scanTo < databaseNow ? input.scanTo : databaseNow
  const retentionFloor = activityRetentionFloor(databaseNow)
  if (input.to <= retentionFloor) throw new TypeError('Activity repair window is outside retained history')
  const frozenInput = {
    ...input,
    from: input.from < retentionFloor ? retentionFloor : input.from,
    scanTo,
  }
  const families = Object.fromEntries(
    ACTIVITY_SOURCE_FAMILIES.map((family) => [
      family,
      { pages: 0, groups: 0, changed: 0, inserted: 0, updated: 0, deleted: 0, errors: 0, elapsedMs: 0, failures: [] },
    ])
  ) as unknown as RepairReport['families']
  // One family at a time keeps `concurrency` as the global write bound and
  // guarantees every in-flight write settles before a lease/abort error returns.
  const startedAt = Date.now()
  for (const family of ACTIVITY_SOURCE_FAMILIES) {
    const familyStartedAt = Date.now()
    await repairFamily(family, frozenInput, families[family])
    families[family].elapsedMs = Date.now() - familyStartedAt
  }
  return {
    groups: Object.values(families).reduce((sum, family) => sum + family.groups, 0),
    elapsedMs: Date.now() - startedAt,
    changed: Object.values(families).reduce((sum, family) => sum + family.changed, 0),
    inserted: Object.values(families).reduce((sum, family) => sum + family.inserted, 0),
    updated: Object.values(families).reduce((sum, family) => sum + family.updated, 0),
    deleted: Object.values(families).reduce((sum, family) => sum + family.deleted, 0),
    errors: Object.values(families).reduce((sum, family) => sum + family.errors, 0),
    families,
  }
}
