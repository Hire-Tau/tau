import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db'

export async function holdRowLock(statement: SQL) {
  const releaseGate = Promise.withResolvers<void>()
  const locked = Promise.withResolvers<number>()
  const transaction = db.transaction(async (tx) => {
    const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid()::int as pid`)
    await tx.execute(statement)
    locked.resolve(backend!.pid)
    await releaseGate.promise
  })

  return {
    pid: await locked.promise,
    release: async () => {
      releaseGate.resolve()
      await transaction
    },
  }
}

export async function waitForBlockedBy(blockerPids: number[], excludePids: number[] = []): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await db.execute<{ pid: number; blockers: number[] }>(sql`
      select pid::int, pg_blocking_pids(pid)::int[] as blockers
      from pg_stat_activity
      where wait_event_type = 'Lock'
    `)
    const waiter = rows.find(
      (row) => !excludePids.includes(row.pid) && row.blockers.some((blocker) => blockerPids.includes(blocker))
    )
    if (waiter) return waiter.pid
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for a backend blocked by ${blockerPids.join(', ')}`)
}
