import { afterAll as maintenanceAfterAll, beforeAll as maintenanceBeforeAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../../../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
maintenanceBeforeAll(async () => (releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()))
maintenanceAfterAll(() => releaseMaintenanceIsolation?.())

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { db } from '../../../db'
import { k8sProvisionAttempts, k8sProvisionControls } from '../../../db/schema'
import { eq, sql } from 'drizzle-orm'
import { DEFAULT_PROVISION_CONFIG } from './provision-config'
import { PostgresProvisionStore, safeCoordinationErrorMetadata } from './provision-store'

const config = { ...DEFAULT_PROVISION_CONFIG, maxConcurrent: 2 }
let scope: string
let stores: PostgresProvisionStore[]
let ownedScopes: string[]
const claim = (sandboxKey: string, operationKind: 'ensure' | 'recreate' = 'ensure', desiredSpecHash = 'spec') => ({
  scope,
  sandboxKey,
  operationKind,
  desiredSpecHash,
  ownerId: crypto.randomUUID(),
})

beforeEach(() => {
  scope = crypto.randomUUID()
  ownedScopes = [scope]
  stores = [new PostgresProvisionStore({ db, config }), new PostgresProvisionStore({ db, config })]
})
afterEach(async () => {
  for (const ownedScope of ownedScopes) {
    await db.delete(k8sProvisionAttempts).where(eq(k8sProvisionAttempts.scope, ownedScope))
    await db.delete(k8sProvisionControls).where(eq(k8sProvisionControls.scope, ownedScope))
  }
})

describe('PostgresProvisionStore', () => {
  test('atomically returns one owner and one compatible joiner', async () => {
    const results = await Promise.all([stores[0]!.claim(claim('box')), stores[1]!.claim(claim('box'))])
    expect(results.map((result) => result.kind).sort()).toEqual(['join', 'owner'])
    if (!('attempt' in results[0]!) || !('attempt' in results[1]!)) throw new Error('expected attempts')
    expect(results[0].attempt?.attemptId).toBe(results[1].attempt?.attemptId)
  })

  test('rejects incompatible operation and spec joins', async () => {
    expect((await stores[0]!.claim(claim('box', 'ensure', 'a'))).kind).toBe('owner')
    expect((await stores[1]!.claim(claim('box', 'recreate', 'a'))).kind).toBe('busy')
    expect((await stores[1]!.claim(claim('box', 'ensure', 'b'))).kind).toBe('busy')
  })

  test('enforces global capacity without creating a queued row', async () => {
    expect((await stores[0]!.claim(claim('a'))).kind).toBe('owner')
    expect((await stores[0]!.claim(claim('b'))).kind).toBe('owner')
    expect((await stores[0]!.claim(claim('c'))).kind).toBe('busy')
    expect(await db.select().from(k8sProvisionAttempts).where(eq(k8sProvisionAttempts.scope, scope))).toHaveLength(2)
  })

  test('opens after qualifying failures and rejects subsequent claims', async () => {
    for (const key of ['a', 'b', 'c']) {
      const result = await stores[0]!.claim(claim(key))
      if (result.kind !== 'owner') throw new Error('expected owner')
      await stores[0]!.complete({ attempt: result.attempt, kind: 'failure', failureCode: 'control_plane_unavailable' })
    }
    const rejected = await stores[1]!.claim(claim('d'))
    expect(rejected).toMatchObject({ kind: 'open', reasonCode: 'control_plane_unavailable' })
  })

  test('opens for qualifying failures staggered within the configured window', async () => {
    const staggered = new PostgresProvisionStore({
      db,
      config: { ...config, failureThreshold: 3, failureWindowMs: 500 },
    })
    for (const key of ['stagger-a', 'stagger-b', 'stagger-c']) {
      const result = await staggered.claim(claim(key))
      if (result.kind !== 'owner') throw new Error('expected owner')
      await staggered.complete({ attempt: result.attempt, kind: 'failure', failureCode: 'unschedulable_capacity' })
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(await staggered.diagnostics(scope)).toMatchObject({ state: 'open', recentFailureCount: 3 })
  })

  test('reopens an expired half-open probe and later admits one replacement probe', async () => {
    await db.insert(k8sProvisionControls).values({
      scope,
      state: 'open',
      retryAt: new Date(Date.now() - 1),
      reasonCode: 'control_plane_unavailable',
    })
    const first = await stores[0]!.claim(claim('probe-a'))
    if (first.kind !== 'owner') throw new Error('expected first probe owner')
    expect(first.attempt.probe).toBe(true)
    await db
      .update(k8sProvisionAttempts)
      .set({ leaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(k8sProvisionAttempts.attemptId, first.attempt.attemptId))

    const expired = await new PostgresProvisionStore({ db, config }).claim(claim('probe-b'))
    expect(expired.kind).toBe('open')
    await db
      .update(k8sProvisionControls)
      .set({ retryAt: new Date(Date.now() - 1) })
      .where(eq(k8sProvisionControls.scope, scope))
    const replacements = await Promise.all([stores[0]!.claim(claim('probe-b')), stores[1]!.claim(claim('probe-c'))])
    expect(replacements.filter((result) => result.kind === 'owner')).toHaveLength(1)
    expect(replacements.filter((result) => result.kind === 'open')).toHaveLength(1)
  })

  test('bounds retained terminal rows deterministically without pruning neighboring scopes', async () => {
    const [{ now: databaseNow }] = await db.execute<{ now: string }>(sql`SELECT clock_timestamp() AS now`)
    const neighborScope = crypto.randomUUID()
    ownedScopes.push(neighborScope)
    const now = new Date(databaseNow)
    const completedAt = now
    const terminalRows = Array.from({ length: 128 }, (_, index) => ({
      scope,
      sandboxKey: `retained-${index.toString().padStart(3, '0')}`,
      operationKind: 'ensure',
      desiredSpecHash: 'spec',
      attemptId: crypto.randomUUID(),
      ownerId: crypto.randomUUID(),
      status: index % 3 === 0 ? 'failed' : index % 3 === 1 ? 'cancelled' : 'succeeded',
      leaseExpiresAt: completedAt,
      completedAt,
    }))
    await db.insert(k8sProvisionAttempts).values([
      ...terminalRows,
      {
        ...terminalRows[0]!,
        sandboxKey: 'retained--live',
        attemptId: crypto.randomUUID(),
        status: 'in_progress',
        completedAt: null,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      },
      { ...terminalRows[0]!, scope: neighborScope, sandboxKey: 'unrelated-old', attemptId: crypto.randomUUID() },
    ])

    const roomy = new PostgresProvisionStore({
      db,
      config: { ...config, maxConcurrent: 4 },
      clock: () => now.getTime(),
    })
    const completeClaim = async (sandboxKey: string) => {
      const result = await roomy.claim(claim(sandboxKey))
      if (result.kind !== 'owner') throw new Error(`expected owner for ${sandboxKey}`)
      await roomy.complete({ attempt: result.attempt, kind: 'success', podName: 'pod', resultSpecHash: 'spec' })
    }
    await Promise.all([completeClaim('concurrent-a'), completeClaim('concurrent-b')])
    await Promise.all([completeClaim('retry-a'), completeClaim('retry-b')])
    await completeClaim('final')

    const owned = await db
      .select({ sandboxKey: k8sProvisionAttempts.sandboxKey, status: k8sProvisionAttempts.status })
      .from(k8sProvisionAttempts)
      .where(eq(k8sProvisionAttempts.scope, scope))
    expect(owned.filter(({ status }) => status !== 'in_progress')).toHaveLength(128)
    expect(owned).toEqual(
      expect.arrayContaining([
        { sandboxKey: 'retry-a', status: 'succeeded' },
        { sandboxKey: 'retry-b', status: 'succeeded' },
        { sandboxKey: 'final', status: 'succeeded' },
      ])
    )
    expect(owned).toContainEqual({ sandboxKey: 'retained--live', status: 'in_progress' })
    // Assert each key separately. `not.toEqual(arrayContaining([a, b, c]))` is
    // satisfied as soon as ANY ONE of the three is absent, so it would stay
    // green with `concurrent-a` and `concurrent-b` both still retained.
    for (const sandboxKey of ['concurrent-a', 'concurrent-b', 'retained-000'])
      expect(owned.map((row) => row.sandboxKey)).not.toContain(sandboxKey)
    expect(
      await db
        .select({ sandboxKey: k8sProvisionAttempts.sandboxKey })
        .from(k8sProvisionAttempts)
        .where(eq(k8sProvisionAttempts.scope, neighborScope))
    ).toEqual([{ sandboxKey: 'unrelated-old' }])
  })

  test('prunes only terminal rows strictly older than the database retention boundary', async () => {
    const [{ now: databaseNow }] = await db.execute<{ now: string }>(sql`SELECT clock_timestamp() AS now`)
    // Anchor an hour behind real time. The boundary row sits exactly ON the
    // cutoff, so if the store read a wall clock instead of its injected one the
    // margin would be whatever host/container skew happened to be — which
    // detected a reverted `this.clock()` only 1 run in 3. An hour of separation
    // makes that revert fail every time, on both the terminal-row boundary and
    // the in-progress lease boundary.
    const now = new Date(new Date(databaseNow).getTime() - 3_600_000)
    const cutoff = new Date(now.getTime() - 30_000)
    const old = new Date(cutoff.getTime() - 1)
    const leaseExpiresAt = new Date(now.getTime() + 60_000)
    const neighborScope = crypto.randomUUID()
    ownedScopes.push(neighborScope)
    const rows = [
      ['old-success', 'succeeded', old],
      ['old-failure', 'failed', old],
      ['old-cancelled', 'cancelled', old],
      ['at-boundary', 'succeeded', cutoff],
      ['old-active', 'in_progress', old],
    ] as const
    const attempts = rows.map(([sandboxKey, status, completedAt]) => ({
      scope,
      sandboxKey,
      operationKind: 'ensure',
      desiredSpecHash: 'spec',
      attemptId: crypto.randomUUID(),
      ownerId: crypto.randomUUID(),
      status,
      leaseExpiresAt,
      completedAt,
    }))
    await db
      .insert(k8sProvisionAttempts)
      .values([
        ...attempts,
        { ...attempts[0]!, scope: neighborScope, sandboxKey: 'unrelated-prunable', attemptId: crypto.randomUUID() },
      ])

    const persistedPremises = await db
      .select({
        sandboxKey: k8sProvisionAttempts.sandboxKey,
        status: k8sProvisionAttempts.status,
        completedAt: k8sProvisionAttempts.completedAt,
      })
      .from(k8sProvisionAttempts)
      .where(eq(k8sProvisionAttempts.scope, scope))
    const premiseByKey = new Map(persistedPremises.map((row) => [row.sandboxKey, row]))
    for (const key of ['old-success', 'old-failure', 'old-cancelled']) {
      expect(premiseByKey.get(key)?.completedAt?.getTime()).toBeLessThan(cutoff.getTime())
    }
    expect(premiseByKey.get('old-success')?.status).toBe('succeeded')
    expect(premiseByKey.get('old-failure')?.status).toBe('failed')
    expect(premiseByKey.get('old-cancelled')?.status).toBe('cancelled')
    expect(premiseByKey.get('at-boundary')).toMatchObject({ status: 'succeeded' })
    expect(premiseByKey.get('at-boundary')?.completedAt?.getTime()).toBe(cutoff.getTime())
    expect(premiseByKey.get('old-active')).toMatchObject({ status: 'in_progress' })
    expect(premiseByKey.get('old-active')?.completedAt?.getTime()).toBeLessThan(cutoff.getTime())

    const retentionStore = new PostgresProvisionStore({ db, config, clock: () => now.getTime() })
    const result = await retentionStore.claim(claim('trigger'))
    expect(result.kind).toBe('owner')
    const remaining = await db
      .select({ sandboxKey: k8sProvisionAttempts.sandboxKey })
      .from(k8sProvisionAttempts)
      .where(eq(k8sProvisionAttempts.scope, scope))
    expect(remaining.map(({ sandboxKey }) => sandboxKey)).toEqual(
      expect.arrayContaining(['at-boundary', 'old-active', 'trigger'])
    )
    for (const sandboxKey of ['old-success', 'old-failure', 'old-cancelled'])
      expect(remaining.map((row) => row.sandboxKey)).not.toContain(sandboxKey)
    expect(
      await db
        .select({ sandboxKey: k8sProvisionAttempts.sandboxKey })
        .from(k8sProvisionAttempts)
        .where(eq(k8sProvisionAttempts.scope, neighborScope))
    ).toEqual([{ sandboxKey: 'unrelated-prunable' }])
  })

  test('fences stale heartbeats and completions after cancellation', async () => {
    const result = await stores[0]!.claim(claim('box'))
    if (result.kind !== 'owner') throw new Error('expected owner')
    await stores[0]!.cancelOwned(result.attempt.ownerId)
    expect(await stores[0]!.heartbeat(result.attempt)).toBe(false)
    expect(
      (await stores[0]!.complete({ attempt: result.attempt, kind: 'success', podName: 'pod', resultSpecHash: 'spec' }))
        .accepted
    ).toBe(false)
  })
})

describe('coordination dependency diagnostics', () => {
  test('redacts arbitrary error content and rate-limits safe metadata', async () => {
    let now = 1
    const events: unknown[] = []
    const failingDb = {
      transaction: async () => {
        throw Object.assign(new Error('TOKEN-SECRET'), { code: '42P01', body: 'TOKEN-SECRET' })
      },
    }
    const store = new PostgresProvisionStore({
      db: failingDb as any,
      config,
      clock: () => now,
      onCoordinationError: (metadata) => events.push(metadata),
    })
    await expect(store.claim(claim('missing-table'))).rejects.toMatchObject({
      code: 'SANDBOX_PROVISION_COORDINATION_UNAVAILABLE',
    })
    await expect(store.claim(claim('missing-table'))).rejects.toBeDefined()
    expect(events).toEqual([{ name: 'Error', code: '42P01' }])
    expect(JSON.stringify(events)).not.toContain('TOKEN-SECRET')
    now += 30_000
    await expect(store.claim(claim('missing-table'))).rejects.toBeDefined()
    expect(events).toHaveLength(2)
    expect(safeCoordinationErrorMetadata({ name: 'TOKEN SECRET', code: 'bad secret!' })).toEqual({ name: 'Error' })
  })
})
