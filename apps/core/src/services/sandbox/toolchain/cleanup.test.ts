import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { eq, sql, type SQL } from 'drizzle-orm'
import { db } from '../../../db'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { agents, sandboxToolchainActivations, sandboxToolchainProvisions, squads } from '../../../db/schema'
import { cleanupOrphanToolchainStateBatch, cleanupTerminalToolchainResultsBatch } from './cleanup'
import { markActivationRequired, markDesired } from './state'

const squadId = '22222222-2222-4222-8222-222222222222'
const otherSquadId = '33333333-3333-4333-8333-333333333333'
const fingerprint = 'c'.repeat(64)

async function result(id: string, status: 'ready' | 'failed' | 'pending', age: string) {
  await db.insert(sandboxToolchainProvisions).values({
    sandboxId: id,
    squadId,
    desiredFingerprint: fingerprint,
    status,
    completedAt: sql`CURRENT_TIMESTAMP - ${sql.raw(`interval '${age}'`)}`,
    updatedAt: sql`CURRENT_TIMESTAMP - ${sql.raw(`interval '${age}'`)}`,
  })
}

/** Hold a real row lock from a known backend until release resolves. */
async function holdRowLock(statement: SQL): Promise<{ pid: number; release: () => Promise<void> }> {
  let unblock!: () => void
  let held!: (pid: number) => void
  let released = false
  const blocked = new Promise<void>((resolve) => (unblock = resolve))
  const locked = new Promise<number>((resolve) => (held = resolve))
  const transaction = db.transaction(async (tx) => {
    const [backend] = (await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`)) as unknown as Array<{ pid: number }>
    await tx.execute(statement)
    held(backend!.pid)
    await blocked
  })
  const pid = await locked
  return {
    pid,
    release: async () => {
      if (!released) {
        released = true
        unblock()
      }
      await transaction
    },
  }
}

/** Find the concrete backend parked behind `blockerPid`, ignoring known waiters. */
async function waitForBlockedBy(blockerPid: number, excludePids: number[] = []): Promise<number> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const rows = (await db.execute(sql`
      SELECT pid::int AS pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND ${blockerPid} = ANY(pg_blocking_pids(pid))
      ORDER BY pid
    `)) as unknown as Array<{ pid: number }>
    const waiter = rows.find((row) => !excludePids.includes(row.pid))
    if (waiter) return waiter.pid
    await Bun.sleep(5)
  }
  throw new Error(`timed out waiting for a backend blocked by pid ${blockerPid}`)
}

/**
 * Return once this operation settles or a backend is specifically observed
 * behind the transaction holding its fixture row. Never silently time out.
 */
async function settleOrBlock(pending: Promise<unknown>, blockerPid: number): Promise<void> {
  let settled = false
  void pending.then(
    () => (settled = true),
    () => (settled = true)
  )
  for (let attempt = 0; attempt < 400; attempt++) {
    if (settled) return
    const rows = (await db.execute(sql`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database()
        AND ${blockerPid} = ANY(pg_blocking_pids(pid))
    `)) as unknown as unknown[]
    if (rows.length > 0) return
    await Bun.sleep(5)
  }
  throw new Error(`operation neither settled nor blocked by pid ${blockerPid}`)
}

describe('toolchain state cleanup', () => {
  beforeAll(async () => {
    await db
      .insert(squads)
      .values([
        { id: squadId, name: 'Cleanup', purpose: 'test' },
        { id: otherSquadId, name: 'Other cleanup', purpose: 'test' },
      ])
      .onConflictDoNothing()
  })
  afterEach(async () => {
    await db.delete(sandboxToolchainProvisions).where(eq(sandboxToolchainProvisions.squadId, squadId))
    await db.delete(sandboxToolchainActivations).where(eq(sandboxToolchainActivations.squadId, squadId))
    await db.delete(agents).where(eq(agents.squadId, squadId))
    await db.delete(agents).where(eq(agents.squadId, otherSquadId))
  })
  afterAll(async () => {
    await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(squads).where(eq(squads.id, otherSquadId))
  })

  it('deletes only a bounded batch of old terminal results and preserves activation', async () => {
    await result('old-failed', 'failed', '31 days')
    await result('old-ready', 'ready', '32 days')
    await result('old-pending', 'pending', '40 days')
    await result('recent-ready', 'ready', '1 day')
    await db.insert(sandboxToolchainActivations).values({ sandboxId: 'old-ready', squadId })

    expect(await cleanupTerminalToolchainResultsBatch({ retentionMs: 30 * 86_400_000, batchSize: 2 })).toEqual([
      'old-ready',
      'old-failed',
    ])
    expect(
      await db.select().from(sandboxToolchainActivations).where(eq(sandboxToolchainActivations.sandboxId, 'old-ready'))
    ).toHaveLength(1)
    expect(
      await db.select().from(sandboxToolchainProvisions).where(eq(sandboxToolchainProvisions.sandboxId, 'old-pending'))
    ).toHaveLength(1)
  })

  it('uses the transaction DB clock and a strict retention boundary', async () => {
    await db.transaction(async (tx) => {
      await tx.insert(sandboxToolchainProvisions).values([
        {
          sandboxId: 'terminal-boundary',
          squadId,
          desiredFingerprint: fingerprint,
          status: 'failed',
          completedAt: sql`CURRENT_TIMESTAMP - interval '30 days'`,
          updatedAt: sql`CURRENT_TIMESTAMP - interval '30 days'`,
        },
        {
          sandboxId: 'terminal-one-ms-older',
          squadId,
          desiredFingerprint: fingerprint,
          status: 'failed',
          completedAt: sql`CURRENT_TIMESTAMP - interval '30 days' - interval '1 millisecond'`,
          updatedAt: sql`CURRENT_TIMESTAMP - interval '30 days' - interval '1 millisecond'`,
        },
      ])
      expect(await cleanupTerminalToolchainResultsBatch({ retentionMs: 30 * 86_400_000, batchSize: 10 }, tx)).toEqual([
        'terminal-one-ms-older',
      ])
    })
  })

  it('claims disjoint bounded terminal batches across concurrent cleaners', async () => {
    for (let index = 0; index < 4; index++) await result(`concurrent-${index}`, 'failed', `${40 + index} days`)
    const claimed = await Promise.all([
      cleanupTerminalToolchainResultsBatch({ retentionMs: 30 * 86_400_000, batchSize: 2 }),
      cleanupTerminalToolchainResultsBatch({ retentionMs: 30 * 86_400_000, batchSize: 2 }),
    ])
    expect(new Set(claimed.flat()).size).toBe(4)
    expect(claimed[0]?.filter((id) => claimed[1]?.includes(id))).toEqual([])
  })

  it('skips terminal evidence another cleaner already holds instead of waiting for it', async () => {
    for (let index = 0; index < 3; index++) await result(`terminal-held-${index}`, 'failed', `${42 - index} days`)
    const held = await holdRowLock(sql`
      SELECT sandbox_id FROM sandbox_toolchain_provisions
      WHERE sandbox_id = 'terminal-held-0' FOR UPDATE
    `)
    const claimed = cleanupTerminalToolchainResultsBatch({ retentionMs: 30 * 86_400_000, batchSize: 2 })
    try {
      await settleOrBlock(claimed, held.pid)
    } finally {
      // Release before awaiting: without SKIP LOCKED the cleaner is parked on the
      // held row and would deadlock the test instead of claiming it.
      await held.release()
    }
    expect(await claimed).toEqual(['terminal-held-1', 'terminal-held-2'])
  })

  it('skips an orphan whose result evidence another cleaner already holds', async () => {
    for (let index = 0; index < 3; index++) {
      await result(`orphan-held-${index}`, 'pending', `${4 - index} days`)
      await db.insert(sandboxToolchainActivations).values({
        sandboxId: `orphan-held-${index}`,
        squadId,
        updatedAt: sql`CURRENT_TIMESTAMP - ${sql.raw(`interval '${4 - index} days'`)}`,
      })
    }
    const held = await holdRowLock(sql`
      SELECT sandbox_id FROM sandbox_toolchain_provisions
      WHERE sandbox_id = 'orphan-held-0' FOR UPDATE
    `)
    const claimed = cleanupOrphanToolchainStateBatch({ retentionMs: 86_400_000, batchSize: 2 })
    try {
      await settleOrBlock(claimed, held.pid)
    } finally {
      await held.release()
    }
    expect(await claimed).toEqual(['orphan-held-1', 'orphan-held-2'])
  })

  it('skips an activation-only orphan another cleaner already holds', async () => {
    for (let index = 0; index < 3; index++) {
      await db.insert(sandboxToolchainActivations).values({
        sandboxId: `orphan-act-held-${index}`,
        squadId,
        updatedAt: sql`CURRENT_TIMESTAMP - ${sql.raw(`interval '${4 - index} days'`)}`,
      })
    }
    const held = await holdRowLock(sql`
      SELECT sandbox_id FROM sandbox_toolchain_activations
      WHERE sandbox_id = 'orphan-act-held-0' FOR UPDATE
    `)
    const claimed = cleanupOrphanToolchainStateBatch({ retentionMs: 86_400_000, batchSize: 2 })
    try {
      await settleOrBlock(claimed, held.pid)
    } finally {
      await held.release()
    }
    expect(await claimed).toEqual(['orphan-act-held-1', 'orphan-act-held-2'])
  })

  it('bounds orphan batches and gives concurrent cleaners disjoint ownership of both evidence rows', async () => {
    const orphanIds = Array.from({ length: 5 }, (_, index) => `orphan-concurrent-${index}`)
    for (const sandboxId of orphanIds) {
      await result(sandboxId, 'pending', '2 days')
      await db.insert(sandboxToolchainActivations).values({
        sandboxId,
        squadId,
        updatedAt: sql`CURRENT_TIMESTAMP - interval '2 days'`,
      })
    }

    const claimed = await Promise.all([
      cleanupOrphanToolchainStateBatch({ retentionMs: 86_400_000, batchSize: 2 }),
      cleanupOrphanToolchainStateBatch({ retentionMs: 86_400_000, batchSize: 2 }),
    ])
    expect(claimed[0]).toHaveLength(2)
    expect(claimed[1]).toHaveLength(2)
    expect(claimed[0]?.filter((id) => claimed[1]?.includes(id))).toEqual([])
    expect(new Set(claimed.flat()).size).toBe(4)
    expect(await cleanupOrphanToolchainStateBatch({ retentionMs: 86_400_000, batchSize: 2 })).toHaveLength(1)
    expect(await db.select().from(sandboxToolchainProvisions)).not.toContainEqual(
      expect.objectContaining({ sandboxId: expect.stringContaining('orphan-concurrent-') })
    )
    expect(await db.select().from(sandboxToolchainActivations)).not.toContainEqual(
      expect.objectContaining({ sandboxId: expect.stringContaining('orphan-concurrent-') })
    )
  })

  it('preserves a logical orphan until every evidence row is old', async () => {
    await result('mixed-age-orphan', 'pending', '2 days')
    await db.insert(sandboxToolchainActivations).values({ sandboxId: 'mixed-age-orphan', squadId })
    expect(await cleanupOrphanToolchainStateBatch({ retentionMs: 86_400_000, batchSize: 10 })).toEqual([])
    expect(
      await db
        .select()
        .from(sandboxToolchainProvisions)
        .where(eq(sandboxToolchainProvisions.sandboxId, 'mixed-age-orphan'))
    ).toHaveLength(1)
  })

  it('races cleanup with a new desired state without deleting the fresh winner', async () => {
    await result('orphan-race', 'pending', '2 days')
    await db.insert(sandboxToolchainActivations).values({
      sandboxId: 'orphan-race',
      squadId,
      updatedAt: sql`CURRENT_TIMESTAMP - interval '2 days'`,
    })
    const nextFingerprint = 'd'.repeat(64)
    await Promise.all([
      cleanupOrphanToolchainStateBatch({ retentionMs: 86_400_000, batchSize: 10 }),
      markDesired({ sandboxId: 'orphan-race', squadId, desiredFingerprint: nextFingerprint }),
    ])
    expect(
      await db
        .select({
          status: sandboxToolchainProvisions.status,
          fingerprint: sandboxToolchainProvisions.desiredFingerprint,
        })
        .from(sandboxToolchainProvisions)
        .where(eq(sandboxToolchainProvisions.sandboxId, 'orphan-race'))
    ).toEqual([{ status: 'pending', fingerprint: nextFingerprint }])
  })

  it('aborts the whole logical deletion when a contended activation refresh wins', async () => {
    const sandboxId = 'orphan-activation-race'
    await result(sandboxId, 'pending', '2 days')
    await db.insert(sandboxToolchainActivations).values({
      sandboxId,
      squadId,
      updatedAt: sql`CURRENT_TIMESTAMP - interval '2 days'`,
    })

    const held = await holdRowLock(sql`
      SELECT sandbox_id FROM sandbox_toolchain_activations
      WHERE sandbox_id = ${sandboxId}
      FOR UPDATE
    `)

    // Queue the production refresh first, then the cleaner. PostgreSQL grants the
    // activation row lock in waiter order, so wait for each to be *observably*
    // parked rather than assuming a sleep is long enough to order them.
    let refresh: Promise<void> | undefined
    let cleanup: Promise<string[]> | undefined
    try {
      refresh = markActivationRequired({ sandboxId, squadId, desiredFingerprint: fingerprint })
      const refreshPid = await waitForBlockedBy(held.pid)
      cleanup = cleanupOrphanToolchainStateBatch({ retentionMs: 86_400_000, batchSize: 10 })
      await waitForBlockedBy(refreshPid)
      await held.release()
      await Promise.all([refresh, cleanup])
    } finally {
      await held.release()
      await Promise.allSettled([...(refresh ? [refresh] : []), ...(cleanup ? [cleanup] : [])])
    }

    expect(
      await db.select().from(sandboxToolchainActivations).where(eq(sandboxToolchainActivations.sandboxId, sandboxId))
    ).toHaveLength(1)
    expect(
      await db.select().from(sandboxToolchainProvisions).where(eq(sandboxToolchainProvisions.sandboxId, sandboxId))
    ).toHaveLength(1)
  })

  it('invalidates exactly the terminal and orphan rows actually deleted', async () => {
    await result('event-terminal', 'failed', '31 days')
    await result('event-recent', 'failed', '1 hour')
    await result('event-orphan', 'pending', '2 days')
    const events: string[] = []
    const unsubscribe = eventEmitter.on('sandbox.status', ({ sandboxId }) => events.push(sandboxId))
    try {
      await cleanupTerminalToolchainResultsBatch({ retentionMs: 30 * 86_400_000, batchSize: 10 })
      await cleanupOrphanToolchainStateBatch({ retentionMs: 86_400_000, batchSize: 10 })
    } finally {
      unsubscribe()
    }
    expect(events.sort()).toEqual(['event-orphan', 'event-terminal'])
  })

  it('deletes old logical orphans from both evidence tables while keeping canonical squads and extant agents', async () => {
    const orphan = 'malformed-old-sandbox'
    const canonical = `squad_${squadId}`
    const agentId = '22222222-2222-4222-8222-222222222223'
    const agentSandbox = `agent_${agentId}`
    const wrongSquadAgentId = '22222222-2222-4222-8222-222222222224'
    const wrongSquadSandbox = `agent_${wrongSquadAgentId}`
    await db.insert(agents).values([
      { id: agentId, squadId, agentTypeId: 'engineer' },
      { id: wrongSquadAgentId, squadId: otherSquadId, agentTypeId: 'engineer' },
    ])
    await result(orphan, 'pending', '2 days')
    await result(canonical, 'pending', '2 days')
    await result(agentSandbox, 'pending', '2 days')
    await result(wrongSquadSandbox, 'pending', '2 days')
    await db.insert(sandboxToolchainActivations).values([
      { sandboxId: orphan, squadId, updatedAt: sql`CURRENT_TIMESTAMP - interval '2 days'` },
      { sandboxId: canonical, squadId, updatedAt: sql`CURRENT_TIMESTAMP - interval '2 days'` },
      { sandboxId: agentSandbox, squadId, updatedAt: sql`CURRENT_TIMESTAMP - interval '2 days'` },
      { sandboxId: wrongSquadSandbox, squadId, updatedAt: sql`CURRENT_TIMESTAMP - interval '2 days'` },
    ])

    expect(await cleanupOrphanToolchainStateBatch({ retentionMs: 86_400_000, batchSize: 10 })).toEqual([
      wrongSquadSandbox,
      orphan,
    ])
    expect(
      await db.select().from(sandboxToolchainProvisions).where(eq(sandboxToolchainProvisions.sandboxId, orphan))
    ).toEqual([])
    expect(
      await db.select().from(sandboxToolchainActivations).where(eq(sandboxToolchainActivations.sandboxId, orphan))
    ).toEqual([])
    expect(
      await db.select().from(sandboxToolchainProvisions).where(eq(sandboxToolchainProvisions.sandboxId, canonical))
    ).toHaveLength(1)
    expect(
      await db.select().from(sandboxToolchainProvisions).where(eq(sandboxToolchainProvisions.sandboxId, agentSandbox))
    ).toHaveLength(1)
  })
})
