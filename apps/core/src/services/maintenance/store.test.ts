import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'
import { asc, eq, sql } from 'drizzle-orm'
import {
  agents,
  db,
  executionAdmissionReservations,
  executions,
  instanceMaintenanceAudit,
  instanceMaintenanceState,
} from '../../db'
import { MaintenanceLeaseConflict, MaintenanceStore } from './store'
import { MaintenanceWorkerController } from './worker-controller'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
beforeAll(async () => {
  releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()
})
afterAll(() => releaseMaintenanceIsolation?.())

const owner = '00000000-0000-4000-8000-000000000001'
const lease = '00000000-0000-4000-8000-000000000002'

describe('MaintenanceStore', () => {
  const store = new MaintenanceStore()

  beforeEach(async () => {
    await db.delete(instanceMaintenanceAudit)
    await db.delete(instanceMaintenanceState)
    await store.initialize()
  })
  afterEach(async () => {
    await db.delete(executions)
    await db.delete(agents)
    await db.delete(instanceMaintenanceAudit)
    await db.delete(instanceMaintenanceState)
  })

  it('revokes ownerless queued admissions immediately when maintenance begins', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'maintenance-queue-test' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'queued' }).returning()
    await db
      .insert(executionAdmissionReservations)
      .values({ agentId: agent.id, executionId: execution.id, state: 'queued' })

    await store.setAdminHold({ active: true, reason: 'host work', actor: 'user:u1' })

    const [reservation] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(reservation.state).toBe('revoked')
  })

  it('returns a locked snapshot with a database-authored clock', async () => {
    await store.setAdminHold({ active: true, reason: 'host work', actor: 'user:u1' })

    const locked = await db.transaction((tx) => store.readLocked(tx))

    expect(locked.state.effective).toBe(true)
    expect(locked.state.generation).toBeGreaterThan(0)
    expect(locked.databaseNow).toBeInstanceOf(Date)
  })

  it('keeps admin and platform holders independent', async () => {
    await store.setAdminHold({ active: true, reason: 'host work', actor: 'user:u1' })
    await store.acquireOrRenewLease({
      leaseId: lease,
      ownerTokenId: owner,
      holder: 'resize-machine-host:j1',
      ttlSeconds: 300,
      actor: `system-token:${owner}`,
    })
    await store.setAdminHold({ active: false, actor: 'user:u1' })

    const snapshot = await store.read()
    expect(snapshot.effective).toBe(true)
    expect(snapshot.adminHold.active).toBe(false)
    expect(snapshot.platformLease.active).toBe(true)
    expect(snapshot.generation).toBe(1)
  })

  it('allows only one active platform lease owner', async () => {
    await store.acquireOrRenewLease({
      leaseId: lease,
      ownerTokenId: owner,
      holder: 'first',
      ttlSeconds: 300,
      actor: `system-token:${owner}`,
    })
    await expect(
      store.acquireOrRenewLease({
        leaseId: '00000000-0000-4000-8000-000000000003',
        ownerTokenId: '00000000-0000-4000-8000-000000000004',
        holder: 'second',
        ttlSeconds: 300,
        actor: 'system-token:other',
      })
    ).rejects.toBeInstanceOf(MaintenanceLeaseConflict)
  })

  it('serializes concurrent competing lease acquisition', async () => {
    const attempts = await Promise.allSettled([
      store.acquireOrRenewLease({
        leaseId: lease,
        ownerTokenId: owner,
        holder: 'first',
        ttlSeconds: 300,
        actor: 'first',
      }),
      store.acquireOrRenewLease({
        leaseId: '00000000-0000-4000-8000-000000000003',
        ownerTokenId: '00000000-0000-4000-8000-000000000004',
        holder: 'second',
        ttlSeconds: 300,
        actor: 'second',
      }),
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    const rejection = attempts.find((attempt) => attempt.status === 'rejected') as PromiseRejectedResult
    expect(rejection.reason).toBeInstanceOf(MaintenanceLeaseConflict)
  })

  // TTL expiry is the ONLY automatic recovery from a platform holder that dies
  // mid-maintenance: nothing else ever clears platform_lease_*. Without this,
  // treating any non-null expiry as active — a pause that can never end — is
  // invisible to the suite. The row is written directly because
  // acquireOrRenewLease can only ever mint a FUTURE deadline.
  it('stops holding the pause once the lease deadline has passed', async () => {
    const past = new Date(Date.now() - 1_000)
    await db
      .update(instanceMaintenanceState)
      .set({
        platformLeaseId: lease,
        platformLeaseOwnerTokenId: owner,
        platformLeaseHolder: 'dead-holder',
        platformLeaseAcquiredAt: new Date(Date.now() - 301_000),
        platformLeaseExpiresAt: past,
        generation: 1,
      })
      .where(eq(instanceMaintenanceState.id, 'global'))

    const expired = await store.read()
    expect(expired.platformLease.active).toBe(false)
    expect(expired.effective).toBe(false)
    expect(expired.phase).toBe('active')
    // The identity is still readable — "expired" must not be confused with "absent".
    expect(expired.platformLease.leaseId).toBe(lease)

    // A dead holder must not wedge out the next operation either.
    const takenOver = await store.acquireOrRenewLease({
      leaseId: '00000000-0000-4000-8000-000000000009',
      ownerTokenId: '00000000-0000-4000-8000-00000000000a',
      holder: 'successor',
      ttlSeconds: 300,
      actor: 'successor',
    })
    expect(takenOver.platformLease.active).toBe(true)
    expect(takenOver.platformLease.holder).toBe('successor')
    expect(takenOver.generation).toBe(2)
    const actions = (await db.select().from(instanceMaintenanceAudit)).map((row) => row.action)
    expect(actions).toContain('expired_lease_replaced')
  })

  it('rejects lease TTL outside the safety bounds', async () => {
    await expect(
      store.acquireOrRenewLease({ leaseId: lease, ownerTokenId: owner, holder: 'x', ttlSeconds: 60, actor: 'x' })
    ).rejects.toThrow('ttlSeconds')
  })

  it('uses one database-authored instant for admin state and audit', async () => {
    await store.setAdminHold({ active: true, reason: 'clock invariant', actor: 'user:u1' })
    const [state] = await db.select().from(instanceMaintenanceState)
    const [audit] = await db.select().from(instanceMaintenanceAudit)
    expect(state!.adminHeldAt?.getTime()).toBe(state!.updatedAt.getTime())
    expect(audit!.createdAt.getTime()).toBe(state!.updatedAt.getTime())
    expect(audit).toMatchObject({ action: 'admin_acquired', generation: state!.generation, effective: true })
  })

  it('keeps lease acquisition and renewal timestamps/generation coherent', async () => {
    await store.acquireOrRenewLease({
      leaseId: lease,
      ownerTokenId: owner,
      holder: 'clock-test',
      ttlSeconds: 120,
      actor: `system-token:${owner}`,
    })
    const [acquired] = await db.select().from(instanceMaintenanceState)
    const acquiredAt = acquired!.platformLeaseAcquiredAt!.getTime()
    const generation = acquired!.generation
    let rows = await db.select().from(instanceMaintenanceAudit).orderBy(instanceMaintenanceAudit.createdAt)
    expect(rows[0]!.createdAt.getTime()).toBe(acquired!.updatedAt.getTime())
    expect(rows[0]!.leaseExpiresAt?.getTime()).toBe(acquired!.platformLeaseExpiresAt!.getTime())
    expect(acquired!.platformLeaseExpiresAt!.getTime() - rows[0]!.createdAt.getTime()).toBe(120_000)

    await store.acquireOrRenewLease({
      leaseId: lease,
      ownerTokenId: owner,
      holder: 'clock-test',
      ttlSeconds: 300,
      actor: `system-token:${owner}`,
    })
    const [renewed] = await db.select().from(instanceMaintenanceState)
    rows = await db.select().from(instanceMaintenanceAudit).orderBy(instanceMaintenanceAudit.createdAt)
    expect(renewed!.platformLeaseAcquiredAt!.getTime()).toBe(acquiredAt)
    expect(renewed!.generation).toBe(generation)
    expect(rows[1]).toMatchObject({ action: 'lease_renewed', generation })
    expect(rows[1]!.createdAt.getTime()).toBe(renewed!.updatedAt.getTime())
    expect(renewed!.platformLeaseExpiresAt!.getTime() - rows[1]!.createdAt.getTime()).toBe(300_000)
    expect(renewed!.platformLeaseExpiresAt!.getTime()).toBeGreaterThan(acquired!.platformLeaseExpiresAt!.getTime())
  })

  it('releases multi-row FIFO exactly once across concurrent resumers', async () => {
    const fifoAgents = await db
      .insert(agents)
      .values(Array.from({ length: 6 }, () => ({ agentTypeId: 'worker', status: 'active' as const })))
      .returning()
    const paused = await store.setAdminHold({ active: true, actor: 'fifo' })
    const startedAt = Array.from({ length: 6 }, (_, index) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)))
    const inserted = await db
      .insert(executions)
      .values(
        startedAt.map((timestamp) => ({
          agentId: fifoAgents[startedAt.indexOf(timestamp)]!.id,
          status: 'waiting-maintenance' as const,
          startedAt: timestamp,
          maintenanceGeneration: paused.generation,
          maintenanceQueuedAt: timestamp,
        }))
      )
      .returning({ id: executions.id })
    await store.setAdminHold({ active: false, actor: 'release' })

    const [left, right] = await Promise.all([
      new MaintenanceStore().resumeWaitingExecutions(3),
      new MaintenanceStore().resumeWaitingExecutions(3),
    ])

    const expectedIds = inserted.map(({ id }) => id)
    const batches = [left.map(({ id }) => id), right.map(({ id }) => id)].sort(
      (a, b) => expectedIds.indexOf(a[0]) - expectedIds.indexOf(b[0])
    )
    expect(batches).toEqual([expectedIds.slice(0, 3), expectedIds.slice(3)])
    expect(new Set([...left, ...right].map(({ id }) => id)).size).toBe(6)
    expect(await store.resumeWaitingExecutions()).toEqual([])
    const rows = await db
      .select({ id: executions.id, status: executions.status })
      .from(executions)
      .orderBy(asc(executions.startedAt), asc(executions.id))
    expect(rows).toEqual(expectedIds.map((id) => ({ id, status: 'queued' })))
  })

  it('keeps FIFO blocked on the head row and fences a tail admission when pause re-enters mid-release', async () => {
    const fifoAgents = await db
      .insert(agents)
      .values(Array.from({ length: 3 }, () => ({ agentTypeId: 'worker', status: 'active' as const })))
      .returning()
    const paused = await store.setAdminHold({ active: true, actor: 'fifo-race' })
    const base = Date.UTC(2026, 0, 2)
    const [head, second] = await db
      .insert(executions)
      .values(
        [0, 1].map((offset) => ({
          agentId: fifoAgents[offset]!.id,
          status: 'waiting-maintenance' as const,
          startedAt: new Date(base + offset * 1_000),
          maintenanceGeneration: paused.generation,
          maintenanceQueuedAt: new Date(base + offset * 1_000),
        }))
      )
      .returning()
    await store.setAdminHold({ active: false, actor: 'release' })

    let unlockHead!: () => void
    let headLocked!: () => void
    const locked = new Promise<void>((resolve) => (headLocked = resolve))
    const unlock = new Promise<void>((resolve) => (unlockHead = resolve))
    const blocker = db.transaction(async (tx) => {
      await tx.select({ id: executions.id }).from(executions).where(eq(executions.id, head.id)).for('update')
      headLocked()
      await unlock
    })
    await locked
    const resuming = new MaintenanceStore().resumeWaitingExecutions()
    let waitingBackend = false
    for (let attempt = 0; attempt < 100 && !waitingBackend; attempt++) {
      const result = await db.execute<{ blocked: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
        ) AS blocked
      `)
      waitingBackend = result[0]?.blocked === true
      if (!waitingBackend) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    if (!waitingBackend) unlockHead()
    expect(waitingBackend).toBe(true)

    const reentering = store.setAdminHold({ active: true, actor: 'reenter' })
    const [tail] = await db
      .insert(executions)
      .values({ agentId: fifoAgents[2]!.id, status: 'queued', startedAt: new Date(base + 2_000) })
      .returning()
    unlockHead()
    await blocker
    expect((await resuming).map(({ id }) => id)).toEqual([head.id, second.id])
    const reentered = await reentering
    expect(reentered.effective).toBe(true)

    await new MaintenanceWorkerController(store).reconcileNow()
    const rows = await db
      .select({ id: executions.id, status: executions.status, generation: executions.maintenanceGeneration })
      .from(executions)
      .orderBy(asc(executions.startedAt), asc(executions.id))
    expect(rows.map(({ id }) => id)).toEqual([head.id, second.id, tail.id])
    expect(rows.every((row) => row.status === 'waiting-maintenance')).toBe(true)
    expect(rows.every((row) => row.generation === reentered.generation)).toBe(true)
  })

  it('treats a lease expiring at the sampled DB millisecond as inactive and releases idempotently', async () => {
    await db
      .update(instanceMaintenanceState)
      .set({
        platformLeaseId: lease,
        platformLeaseOwnerTokenId: owner,
        platformLeaseHolder: 'expired',
        platformLeaseAcquiredAt: sql`date_trunc('milliseconds', clock_timestamp()) - interval '1 minute'`,
        platformLeaseExpiresAt: sql`date_trunc('milliseconds', clock_timestamp())`,
        generation: 1,
      })
      .where(eq(instanceMaintenanceState.id, 'global'))
    expect((await store.read()).platformLease.active).toBe(false)
    const replacement = await store.acquireOrRenewLease({
      leaseId: '00000000-0000-4000-8000-000000000009',
      ownerTokenId: '00000000-0000-4000-8000-00000000000a',
      holder: 'replacement',
      ttlSeconds: 120,
      actor: 'replacement',
    })
    expect(replacement.generation).toBe(2)
    await store.releaseLease({
      leaseId: replacement.platformLease.leaseId!,
      ownerTokenId: '00000000-0000-4000-8000-00000000000a',
      actor: 'replacement',
    })
    const once = await db.select().from(instanceMaintenanceAudit)
    const snapshot = await store.releaseLease({
      leaseId: replacement.platformLease.leaseId!,
      ownerTokenId: '00000000-0000-4000-8000-00000000000a',
      actor: 'replacement',
    })
    expect(snapshot.generation).toBe(2)
    expect(await db.select().from(instanceMaintenanceAudit)).toHaveLength(once.length)
  })

  it('samples wall clock after a singleton lock wait before classifying expiry', async () => {
    let locked!: () => void
    const lockAcquired = new Promise<void>((resolve) => (locked = resolve))
    const blocking = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR UPDATE`)
      await tx
        .update(instanceMaintenanceState)
        .set({
          platformLeaseId: lease,
          platformLeaseOwnerTokenId: owner,
          platformLeaseHolder: 'expiring-holder',
          platformLeaseAcquiredAt: sql`clock_timestamp() - interval '1 minute'`,
          platformLeaseExpiresAt: sql`clock_timestamp() + interval '100 milliseconds'`,
          generation: 1,
        })
        .where(eq(instanceMaintenanceState.id, 'global'))
      locked()
      await Bun.sleep(200)
    })
    await lockAcquired
    const replacementPromise = store.acquireOrRenewLease({
      leaseId: '00000000-0000-4000-8000-000000000009',
      ownerTokenId: '00000000-0000-4000-8000-00000000000a',
      holder: 'post-wait-replacement',
      ttlSeconds: 120,
      actor: 'replacement',
    })
    await blocking
    const replacement = await replacementPromise
    expect(replacement).toMatchObject({
      effective: true,
      generation: 2,
      platformLease: { active: true, holder: 'post-wait-replacement' },
    })
    const [state] = await db.select().from(instanceMaintenanceState)
    const [audit] = await db.select().from(instanceMaintenanceAudit)
    expect(audit).toMatchObject({ action: 'expired_lease_replaced', generation: 2, effective: true })
    expect(audit!.createdAt.getTime()).toBe(state!.updatedAt.getTime())
    expect(audit!.leaseExpiresAt?.getTime()).toBe(state!.platformLeaseExpiresAt!.getTime())
  })
})
