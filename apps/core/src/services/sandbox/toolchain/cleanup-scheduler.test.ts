import { afterEach, describe, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../../db'
import { sandboxToolchainProvisions, squads } from '../../../db/schema'
import { ToolchainStateCleanupScheduler } from './cleanup-scheduler'

async function flush(): Promise<void> {
  await Bun.sleep(0)
}

const restartSquadId = '55555555-5555-4555-8555-555555555555'

describe('ToolchainStateCleanupScheduler', () => {
  afterEach(async () => {
    await db.delete(squads).where(eq(squads.id, restartSquadId))
  })
  it('runs immediately, schedules the configured interval, suppresses overlap, and stops', async () => {
    const calls: string[] = []
    let tick!: () => void
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => (finish = resolve))
    const scheduler = new ToolchainStateCleanupScheduler({
      sweep: async () => {
        calls.push('sweep')
        await blocked
        return { terminalDeleted: 0, orphanDeleted: 0, batches: 1 }
      },
      intervalMs: 1234,
      setIntervalFn: (callback, interval) => {
        tick = callback
        calls.push(`interval:${interval}`)
        return 7
      },
      clearIntervalFn: (handle) => void calls.push(`clear:${handle}`),
    })
    scheduler.start()
    await flush()
    tick()
    await flush()
    expect(calls).toEqual(['sweep', 'interval:1234'])
    finish()
    await flush()
    scheduler.stop()
    expect(calls.at(-1)).toBe('clear:7')
  })

  it('logs a failed tick and retries on the next interval with structured limits and duration', async () => {
    const errors: unknown[] = []
    const infos: unknown[] = []
    let now = 100
    let tick!: () => void
    let attempts = 0
    const scheduler = new ToolchainStateCleanupScheduler({
      sweep: async () => {
        attempts++
        if (attempts === 1) throw new Error('database unavailable')
        return { terminalDeleted: 1, orphanDeleted: 0, batches: 1 }
      },
      logger: { info: (...args) => infos.push(args), error: (...args) => errors.push(args) },
      now: () => (now += 25),
      setIntervalFn: (callback) => {
        tick = callback
        return 1
      },
      clearIntervalFn: () => {},
    })
    scheduler.start()
    await flush()
    tick()
    await flush()
    expect(attempts).toBe(2)
    expect(errors).toHaveLength(1)
    expect(infos).toEqual([
      ['Toolchain state cleanup complete', { terminalDeleted: 1, orphanDeleted: 0, batches: 1, durationMs: 25 }],
    ])
  })

  it('is silent when an immediate sweep changes no rows', async () => {
    const infos: unknown[] = []
    const scheduler = new ToolchainStateCleanupScheduler({
      sweep: async () => ({ terminalDeleted: 0, orphanDeleted: 0, batches: 1 }),
      logger: { info: (...args) => infos.push(args), error: () => {} },
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    })
    scheduler.start()
    await flush()
    expect(infos).toEqual([])
    scheduler.stop()
  })

  it('immediately removes persisted terminal evidence after scheduler restart', async () => {
    await db.insert(squads).values({ id: restartSquadId, name: 'Restart cleanup', purpose: 'test' })
    await db.insert(sandboxToolchainProvisions).values({
      sandboxId: `squad_${restartSquadId}`,
      squadId: restartSquadId,
      desiredFingerprint: 'e'.repeat(64),
      status: 'failed',
      completedAt: sql`CURRENT_TIMESTAMP - interval '31 days'`,
      updatedAt: sql`CURRENT_TIMESTAMP - interval '31 days'`,
    })
    const scheduler = new ToolchainStateCleanupScheduler({
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      logger: { info: () => {}, error: () => {} },
    })
    scheduler.start()
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await db
        .select()
        .from(sandboxToolchainProvisions)
        .where(eq(sandboxToolchainProvisions.squadId, restartSquadId))
      if (rows.length === 0) break
      await Bun.sleep(5)
    }
    expect(
      await db.select().from(sandboxToolchainProvisions).where(eq(sandboxToolchainProvisions.squadId, restartSquadId))
    ).toEqual([])
    scheduler.stop()
  })
})
