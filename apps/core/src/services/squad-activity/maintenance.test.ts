import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { squadActivity, squadActivityMaintenanceLeases, squads } from '../../db/schema'
import { activityRetentionFloor } from '../squad/activity-cursor'
import {
  ACTIVITY_REPAIR_LEASE_TASK,
  activityDatabaseNow,
  pruneSquadActivity,
  readActivityRepairWatermarks,
  releaseActivityMaintenanceLease,
  REPAIR_FULL_INTERVAL_MS,
  REPAIR_INCREMENTAL_OVERLAP_MS,
  REPAIR_LIVE_PUBLISH_MS,
  REPAIR_WINDOW_MS,
  runActivityRepair,
  runActivityRepairTick,
  runLeasedActivityRepair,
} from './maintenance'
import type { RepairReport } from './repair'

const squadIds: string[] = []
afterEach(async () => {
  for (const squadId of squadIds.splice(0)) {
    await db.delete(squadActivity).where(eq(squadActivity.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
})
const row = (squadId: string, at: Date) => ({
  squadId,
  lane: 70,
  rowId: crypto.randomUUID(),
  sourceFamily: 'github-pr',
  sourceGroupId: crypto.randomUUID(),
  at,
  agentId: null,
  workStreamId: null,
  agentTypeId: null,
  kind: 'pr' as const,
  summary: '[PR #1 closed]',
  ref: { type: 'pr' as const, url: 'https://github.com/acme/widgets/pull/1' },
  quietEligible: true,
  accessScope: 'workstreams' as const,
  inboxRecipientId: null,
  payloadHash: 'b'.repeat(64),
})

describe('Activity maintenance', () => {
  test('surfaces partial periodic repair reports while treating lease misses as normal', async () => {
    await expect(runActivityRepairTick(async () => null)).resolves.toBeUndefined()
    const family = (errors = 0) => ({
      pages: 0,
      groups: 0,
      changed: 0,
      inserted: 0,
      updated: 0,
      deleted: 0,
      errors,
      elapsedMs: 0,
      failures: errors ? [{ phase: 'source-page' as const, message: 'broken page' }] : [],
    })
    const families = {
      chat: family(1),
      inbox: family(),
      execution: family(),
      workstream: family(),
      wait: family(),
      'github-pr': family(),
      'github-issue': family(),
    }
    await expect(
      runActivityRepairTick(async () => ({
        groups: 0,
        changed: 0,
        inserted: 0,
        updated: 0,
        deleted: 0,
        errors: 1,
        elapsedMs: 0,
        families,
      }))
    ).rejects.toThrow('chat')
  })

  test('rejects wrong and expired lease tokens on release', async () => {
    const task = `release-test-${crypto.randomUUID()}`
    const token = crypto.randomUUID()
    await db.insert(squadActivityMaintenanceLeases).values({
      task,
      leaseToken: token,
      leaseUntil: new Date(Date.now() + 60_000),
    })
    await expect(releaseActivityMaintenanceLease(task, crypto.randomUUID())).rejects.toThrow('lease lost')
    expect(
      await db.select().from(squadActivityMaintenanceLeases).where(eq(squadActivityMaintenanceLeases.task, task))
    ).toHaveLength(1)
    await db
      .update(squadActivityMaintenanceLeases)
      .set({ leaseUntil: new Date(Date.now() - 1_000) })
      .where(eq(squadActivityMaintenanceLeases.task, task))
    await expect(releaseActivityMaintenanceLease(task, token)).rejects.toThrow('lease lost')
    await db
      .update(squadActivityMaintenanceLeases)
      .set({ leaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(squadActivityMaintenanceLeases.task, task))
    await releaseActivityMaintenanceLease(task, token)
    expect(
      await db.select().from(squadActivityMaintenanceLeases).where(eq(squadActivityMaintenanceLeases.task, task))
    ).toEqual([])
  })

  test('uses the database clock and allows only one leased repair owner', async () => {
    const now = await activityDatabaseNow()
    expect(Math.abs(Date.now() - now.valueOf())).toBeLessThan(10_000)
    const input = {
      from: new Date('2099-01-01T00:00:00Z'),
      to: new Date('2099-01-01T00:01:00Z'),
      pageSize: 1,
    }
    const results = await Promise.all([
      runLeasedActivityRepair(input),
      runLeasedActivityRepair({ ...input, task: ACTIVITY_REPAIR_LEASE_TASK }),
    ])
    expect(results.filter((result) => result === null)).toHaveLength(1)
    expect(results.filter((result) => result !== null)).toHaveLength(1)
  })

  test('rejects alternate repair lease namespaces before acquisition', async () => {
    await expect(
      runLeasedActivityRepair({
        from: new Date('2099-01-01T00:00:00Z'),
        to: new Date('2099-01-01T00:01:00Z'),
        task: 'alternate-repair-namespace',
      })
    ).rejects.toThrow(TypeError)
  })

  test('propagates abort and releases the shared lease', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stop repair'))
    const input = {
      from: new Date('2099-02-01T00:00:00Z'),
      to: new Date('2099-02-01T00:01:00Z'),
      signal: controller.signal,
    }
    await expect(runLeasedActivityRepair(input)).rejects.toThrow('stop repair')
    expect(await runLeasedActivityRepair({ ...input, signal: undefined })).not.toBeNull()
  })

  test('prunes strictly before the frozen UTC floor', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-prune-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const floor = activityRetentionFloor(await activityDatabaseNow())
    const old = row(squad.id, new Date(floor.valueOf() - 1))
    const boundary = row(squad.id, floor)
    await db.insert(squadActivity).values([old, boundary])
    expect(await pruneSquadActivity()).toBeGreaterThanOrEqual(1)
    const remaining = await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
    expect(remaining.map((item) => item.rowId)).toEqual([boundary.rowId])
  })
})

describe('Activity repair scan watermarks', () => {
  const now = new Date('2026-09-01T12:00:00.000Z')
  const emptyReport = (errors = 0): RepairReport => {
    const family = {
      pages: 0,
      groups: 0,
      changed: 0,
      inserted: 0,
      updated: 0,
      deleted: 0,
      errors: 0,
      elapsedMs: 0,
      failures: [],
    }
    return {
      groups: 0,
      elapsedMs: 0,
      changed: 0,
      inserted: 0,
      updated: 0,
      deleted: 0,
      errors,
      families: {
        chat: { ...family, errors },
        inbox: { ...family },
        execution: { ...family },
        workstream: { ...family },
        wait: { ...family },
        'github-pr': { ...family },
        'github-issue': { ...family },
      },
    }
  }

  const clearWatermarks = () =>
    db.delete(squadActivityMaintenanceLeases).where(eq(squadActivityMaintenanceLeases.task, ACTIVITY_REPAIR_LEASE_TASK))

  const seedWatermarks = async (incremental: Date | null, full: Date | null) => {
    await clearWatermarks()
    await db.insert(squadActivityMaintenanceLeases).values({
      task: ACTIVITY_REPAIR_LEASE_TASK,
      leaseToken: crypto.randomUUID(),
      // Expired: the watermark row outlives every lease and must never block one.
      leaseUntil: new Date(now.valueOf() - 60_000),
      lastIncrementalScanTo: incremental,
      lastFullScanTo: full,
    })
  }

  const runCapturing = async (report: RepairReport | null) => {
    const inputs: any[] = []
    const result = await runActivityRepair({
      now: async () => now,
      run: async (input) => {
        inputs.push(input)
        return report
      },
    })
    expect(inputs).toHaveLength(1)
    return { input: inputs[0], result }
  }

  afterEach(clearWatermarks)

  test('sweeps the full window and records both watermarks when none exist', async () => {
    await clearWatermarks()
    const { input } = await runCapturing(emptyReport())
    expect(input.from).toEqual(new Date(now.valueOf() - REPAIR_WINDOW_MS))
    expect(input.to).toEqual(now)
    expect(input.scanTo).toEqual(now)
    expect(input.publishAfter).toEqual(new Date(now.valueOf() - REPAIR_LIVE_PUBLISH_MS))
    expect(input.projectionPass).toBe(true)
    expect(await readActivityRepairWatermarks()).toEqual({ lastIncrementalScanTo: now, lastFullScanTo: now })
  })

  test('scans only since the last incremental watermark, without the projection pass', async () => {
    const lastIncremental = new Date(now.valueOf() - 60 * 60_000)
    await seedWatermarks(lastIncremental, new Date(now.valueOf() - 60 * 60_000))
    const { input } = await runCapturing(emptyReport())
    expect(input.from).toEqual(new Date(lastIncremental.valueOf() - REPAIR_INCREMENTAL_OVERLAP_MS))
    expect(input.to).toEqual(now)
    expect(input.projectionPass).toBe(false)
    const after = await readActivityRepairWatermarks()
    expect(after.lastIncrementalScanTo).toEqual(now)
    // An incremental pass must NOT claim the daily full sweep happened.
    expect(after.lastFullScanTo).toEqual(new Date(now.valueOf() - 60 * 60_000))
  })

  test('never scans further back than the retained repair window', async () => {
    await seedWatermarks(new Date(now.valueOf() - 100 * 60 * 60_000), new Date(now.valueOf() - 60_000))
    const { input } = await runCapturing(emptyReport())
    expect(input.from).toEqual(new Date(now.valueOf() - REPAIR_WINDOW_MS))
    expect(input.projectionPass).toBe(false)
  })

  test('leaves watermarks untouched when the sweep reported errors', async () => {
    const lastIncremental = new Date(now.valueOf() - 30 * 60_000)
    const lastFull = new Date(now.valueOf() - 2 * 60 * 60_000)
    await seedWatermarks(lastIncremental, lastFull)
    await runCapturing(emptyReport(1))
    expect(await readActivityRepairWatermarks()).toEqual({
      lastIncrementalScanTo: lastIncremental,
      lastFullScanTo: lastFull,
    })
  })

  test('returns to a full sweep once the full watermark ages past the full interval', async () => {
    const lastFull = new Date(now.valueOf() - REPAIR_FULL_INTERVAL_MS - 60_000)
    await seedWatermarks(new Date(now.valueOf() - 60 * 60_000), lastFull)
    const { input } = await runCapturing(emptyReport())
    expect(input.from).toEqual(new Date(now.valueOf() - REPAIR_WINDOW_MS))
    expect(input.projectionPass).toBe(true)
    expect(await readActivityRepairWatermarks()).toEqual({ lastIncrementalScanTo: now, lastFullScanTo: now })
  })

  test('does not advance watermarks when the lease was held elsewhere', async () => {
    await seedWatermarks(null, null)
    const { result } = await runCapturing(null)
    expect(result).toBeNull()
    expect(await readActivityRepairWatermarks()).toEqual({ lastIncrementalScanTo: null, lastFullScanTo: null })
  })
})
