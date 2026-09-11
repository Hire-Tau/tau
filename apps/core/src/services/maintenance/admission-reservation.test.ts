import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { agents, db, executionAdmissionReservations, executions, instanceMaintenanceState } from '../../db'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'
import {
  AdmissionReservationStore,
  AdmissionScope,
  NestedAdmissionEffectError,
  type AdmissionHeartbeatOutcome,
} from './admission-reservation'
import { MaintenanceStore } from './store'

const store = new AdmissionReservationStore('worker:test', '00000000-0000-4000-8000-000000000123')
let releaseMaintenanceIsolation: (() => Promise<void>) | undefined

beforeAll(async () => {
  releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()
})
afterAll(() => releaseMaintenanceIsolation?.())

beforeEach(async () => {
  await db.insert(instanceMaintenanceState).values({ id: 'global' }).onConflictDoNothing()
})
afterEach(async () => {
  await db.delete(executionAdmissionReservations)
  await db.delete(executions)
  await db.delete(agents)
  await db.delete(instanceMaintenanceState)
})

describe('AdmissionReservationStore', () => {
  test('a stale lease cannot revoke or release its successor', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const staleLease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(staleLease)).toBe(true)
    const successor = {
      token: crypto.randomUUID(),
      claimEpoch: staleLease.claimEpoch + 1n,
      ownerId: 'worker:successor',
      ownerIncarnation: crypto.randomUUID(),
    }
    await db
      .update(executionAdmissionReservations)
      .set(successor)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    const [before] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    expect(await store.revokeLease(staleLease)).toBe(false)
    expect(await store.releaseLease(staleLease)).toBe(false)
    const [after] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(after).toEqual(before)
  })

  test('every exact lease identity predicate independently fences revoke and release', async () => {
    const mutations: Array<[string, Record<string, unknown>]> = [
      ['token', { token: crypto.randomUUID() }],
      ['claim epoch', { claimEpoch: 2n }],
      ['owner id', { ownerId: 'worker:foreign' }],
      ['owner incarnation', { ownerIncarnation: crypto.randomUUID() }],
      ['generation', { admittedGeneration: 1 }],
      ['holder revision', { admittedHolderRevision: 1n }],
    ]
    for (const [name, mutation] of mutations) {
      const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
      const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
      const staleLease = await store.createProvisional(execution.id)
      expect(await store.adoptLease(staleLease)).toBe(true)
      await db
        .update(executionAdmissionReservations)
        .set(mutation)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      const [before] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))

      expect(await store.revokeLease(staleLease), `${name} must fence revoke`).toBe(false)
      expect(await store.releaseLease(staleLease), `${name} must fence release`).toBe(false)
      const [after] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      expect(after, `${name} successor must be byte-for-byte unchanged`).toEqual(before)
    }
  })

  test('stale phase completion cannot change a successor with a reused operation identity', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const staleLease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(staleLease)).toBe(true)
    const phase = await store.beginWritePhase(staleLease, 'session-create', 'session:test')
    await db
      .update(executionAdmissionReservations)
      .set({ token: crypto.randomUUID(), claimEpoch: staleLease.claimEpoch + 1n })
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    const [before] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    expect(await store.finishWritePhase(staleLease, phase!, 'running')).toBe(false)
    const [after] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(after).toEqual(before)
  })

  test('begins an external write phase only while the admitted maintenance fence is still open', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.beginWritePhase(lease, 'sandbox-ensure', 'sandbox:test')).toBeNull()
    expect(await store.adoptLease(lease)).toBe(true)

    const phase = await store.beginWritePhase(lease, 'sandbox-ensure', 'sandbox:test')

    expect(phase?.state).toBe('starting')
    expect(phase?.phase).toBe('sandbox-ensure')
    expect(phase?.phaseSequence).toBe(1)
  })

  test('foreign incarnation cannot load but can exactly claim a provisional pickup lease', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const oldLease = await store.createProvisional(execution.id)
    await db
      .update(executions)
      .set({ runnerClaimToken: oldLease.token, runnerClaimGeneration: oldLease.generation })
      .where(eq(executions.id, execution.id))
    const restarted = new AdmissionReservationStore('worker:restarted', crypto.randomUUID())

    expect(await restarted.loadLease(execution.id)).toBeNull()
    expect(await restarted.claimProvisionalLease(execution.id, crypto.randomUUID(), oldLease.generation)).toBeNull()
    await db.update(executions).set({ runnerClaimToken: crypto.randomUUID() }).where(eq(executions.id, execution.id))
    expect(await restarted.claimProvisionalLease(execution.id, oldLease.token, oldLease.generation)).toBeNull()
    await db.update(executions).set({ runnerClaimToken: oldLease.token }).where(eq(executions.id, execution.id))
    const claimed = await restarted.claimProvisionalLease(execution.id, oldLease.token, oldLease.generation)
    expect(claimed?.ownerId).toBe('worker:restarted')
    expect(claimed?.ownerIncarnation).not.toBe('00000000-0000-4000-8000-000000000123')
    expect(
      await store.finishWritePhase(
        oldLease,
        { phase: 'none', phaseSequence: 0, operationId: null, resourceKey: null },
        'requested'
      )
    ).toBe(false)
  })

  test('refuses a stale holder revision even when the generation stays unchanged', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    await db
      .update(instanceMaintenanceState)
      .set({ holderRevision: lease.holderRevision + 1n })
      .where(eq(instanceMaintenanceState.id, 'global'))

    expect(await store.beginWritePhase(lease, 'sandbox-ensure', 'sandbox:test')).toBeNull()
  })

  test('a stale phase finisher cannot resurrect a reservation being revoked', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    const phase = await store.beginWritePhase(lease, 'session-create', 'session:test')
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'revoking' })
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    expect(await store.finishWritePhase(lease, phase!, 'running')).toBe(false)
    const [reservation] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(reservation.state).toBe('revoking')
  })

  test('sequences multiple write phases and rejects a crossed finisher', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    const ensure = await store.beginWritePhase(lease, 'sandbox-ensure', 'sandbox:test')
    expect(await store.beginWritePhase(lease, 'toolchain-reconcile', 'sandbox:test')).toBeNull()
    expect(await store.finishWritePhase(lease, ensure!, 'requested')).toBe(true)
    const session = await store.beginWritePhase(lease, 'session-create', 'session:test')
    expect(session?.phaseSequence).toBe(2)
    expect(await store.finishWritePhase(lease, ensure!, 'requested')).toBe(false)
    expect(await store.finishWritePhase(lease, session!, 'running')).toBe(true)
    const agentSession = await store.beginWritePhase(lease, 'agent-session', 'provider:test')
    expect(agentSession?.phaseSequence).toBe(3)
    expect(await store.finishWritePhase(lease, agentSession!, 'running')).toBe(true)
  })

  test('AdmissionScope rejects nested effects without overwriting the open phase', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    const scope = new AdmissionScope(store, lease)

    let releaseOuter!: () => void
    const outerGate = new Promise<void>((resolve) => (releaseOuter = resolve))
    const outer = scope.runEffect({ phase: 'sandbox-ensure', resourceKey: 'sandbox:test' }, () => outerGate)
    while (true) {
      const [row] = await db
        .select({ phase: executionAdmissionReservations.phase })
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      if (row?.phase === 'sandbox-ensure') break
      await Promise.resolve()
    }
    await expect(
      scope.runEffect({ phase: 'toolchain-reconcile', resourceKey: 'sandbox:test' }, async () => {})
    ).rejects.toBeInstanceOf(NestedAdmissionEffectError)
    const [open] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(open.phase).toBe('sandbox-ensure')
    releaseOuter()
    await outer
  })

  test('AdmissionScope restores requested and preserves an ordinary operation error', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    const scope = new AdmissionScope(store, lease)
    const expected = new Error('adapter rejected')

    await expect(
      scope.runEffect({ phase: 'sandbox-ensure', resourceKey: 'sandbox:test' }, async () => {
        throw expected
      })
    ).rejects.toBe(expected)
    const [reservation] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(reservation).toMatchObject({ state: 'requested', phase: 'none', operationId: null, resourceKey: null })
  })

  test('AdmissionScope cleanup runs when pause revokes an authorized effect before it returns', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    const scope = new AdmissionScope(store, lease)
    let releaseEffect!: () => void
    const effectGate = new Promise<void>((resolve) => (releaseEffect = resolve))
    let cleaned = false
    const effect = scope.runEffect(
      { phase: 'session-create', resourceKey: 'execution:test', successState: 'running' },
      async () => {
        await effectGate
        return { session: true }
      },
      () => {
        cleaned = true
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new MaintenanceStore().setAdminHold({ active: true, actor: 'test' })
    releaseEffect()
    await expect(effect).rejects.toThrow('revoked or superseded')
    expect(cleaned).toBe(true)
    const [reservation] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(reservation.state).toBe('revoking')
  })

  test('AdmissionScope joins an in-flight heartbeat before finishing and leaves the next phase live', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    let heartbeatTick!: () => void
    const scope = new AdmissionScope(store, lease, (callback) => {
      heartbeatTick = callback
      return () => {}
    })
    let releaseHeartbeat!: (outcome: AdmissionHeartbeatOutcome) => void
    const heartbeatGate = new Promise<AdmissionHeartbeatOutcome>((resolve) => (releaseHeartbeat = resolve))
    const originalHeartbeat = store.heartbeatEffect.bind(store)
    store.heartbeatEffect = async () => heartbeatGate
    try {
      let releaseEffect!: () => void
      const effectGate = new Promise<void>((resolve) => (releaseEffect = resolve))
      const first = scope.runEffect({ phase: 'sandbox-ensure', resourceKey: 'sandbox:test' }, () => effectGate)
      while (!heartbeatTick) await new Promise<void>((resolve) => setImmediate(resolve))
      heartbeatTick()
      releaseEffect()
      let finished = false
      void first.then(() => (finished = true))
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(finished).toBe(false)
      const [duringHeartbeat] = await db
        .select({ state: executionAdmissionReservations.state })
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      expect(duringHeartbeat?.state).toBe('starting')
      releaseHeartbeat({ ok: true, repaired: false })
      await first
      await scope.runEffect({ phase: 'toolchain-reconcile', resourceKey: 'sandbox:test' }, async ({ signal }) => {
        expect(signal.aborted).toBe(false)
      })
    } finally {
      store.heartbeatEffect = originalHeartbeat
    }
  })

  test('AdmissionScope abort reaches a long-running pre-session adapter signal', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    const scope = new AdmissionScope(store, lease)
    let observedAbort = false
    let release!: () => void
    let listenerReady!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const ready = new Promise<void>((resolve) => (listenerReady = resolve))
    const effect = scope.runEffect({ phase: 'sandbox-ensure', resourceKey: 'sandbox:test' }, async ({ signal }) => {
      signal.addEventListener(
        'abort',
        () => {
          observedAbort = true
          release()
        },
        { once: true }
      )
      listenerReady()
      await gate
    })
    try {
      await ready
      scope.abort(new Error('maintenance'))
      await effect
      expect(observedAbort).toBe(true)
    } finally {
      release()
      await effect.catch(() => undefined)
    }
  })

  test('AdmissionScope test harness joins adapter cleanup after an early assertion path', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    const scope = new AdmissionScope(store, lease)
    let release!: () => void
    let adapterReady!: () => void
    let settled = false
    const gate = new Promise<void>((resolve) => (release = resolve))
    const ready = new Promise<void>((resolve) => (adapterReady = resolve))
    const effect = scope
      .runEffect({ phase: 'sandbox-ensure', resourceKey: 'sandbox:test' }, async () => {
        adapterReady()
        await gate
      })
      .finally(() => {
        settled = true
      })
    try {
      await ready
    } finally {
      release()
      await effect.catch(() => undefined)
    }
    expect(settled).toBe(true)
  })

  test('beginWritePhase starts a fresh phase with a full lease', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    // Nearly lapsed, but not yet: begin must still be admitted and must renew.
    const nearlyLapsed = new Date(Date.now() + 1_000)
    await db
      .update(executionAdmissionReservations)
      .set({ leaseExpiresAt: nearlyLapsed })
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    const phase = await store.beginWritePhase(lease, 'sandbox-ensure', 'sandbox:test')

    expect(phase?.state).toBe('starting')
    expect(phase!.leaseExpiresAt!.getTime()).toBeGreaterThan(nearlyLapsed.getTime() + 20_000)
  })

  test('heartbeat keeps renewing after a transient failure and only a definitive revoke aborts', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    let heartbeatTick!: () => Promise<void>
    const scope = new AdmissionScope(store, lease, (callback) => {
      heartbeatTick = callback as () => Promise<void>
      return () => {}
    })
    const originalHeartbeat = store.heartbeatEffect.bind(store)
    let failNext = 0
    store.heartbeatEffect = async (...args) => {
      if (failNext > 0) {
        failNext -= 1
        throw new Error('connection reset (transient)')
      }
      return originalHeartbeat(...args)
    }
    try {
      let releaseEffect!: () => void
      const effectGate = new Promise<void>((resolve) => (releaseEffect = resolve))
      let signalSeen!: AbortSignal
      const effect = scope.runEffect({ phase: 'sandbox-ensure', resourceKey: 'sandbox:test' }, async ({ signal }) => {
        signalSeen = signal
        await effectGate
      })
      while (!heartbeatTick || !signalSeen) await new Promise<void>((resolve) => setImmediate(resolve))
      const [before] = await db
        .select({ leaseExpiresAt: executionAdmissionReservations.leaseExpiresAt })
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))

      // A transient DB failure must not stop renewals.
      failNext = 1
      await heartbeatTick()
      expect(signalSeen.aborted).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 5))
      await heartbeatTick()
      expect(signalSeen.aborted).toBe(false)
      const [renewed] = await db
        .select({ leaseExpiresAt: executionAdmissionReservations.leaseExpiresAt })
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      expect(renewed!.leaseExpiresAt!.getTime()).toBeGreaterThan(before!.leaseExpiresAt!.getTime())

      // A definitive fence revoke (holder revision moved on) still aborts.
      await db
        .update(instanceMaintenanceState)
        .set({ holderRevision: lease.holderRevision + 1n })
        .where(eq(instanceMaintenanceState.id, 'global'))
      await heartbeatTick()
      expect(signalSeen.aborted).toBe(true)
      expect(String(signalSeen.reason)).toContain('fence-revoked')

      releaseEffect()
      await effect.catch(() => undefined)
    } finally {
      store.heartbeatEffect = originalHeartbeat
    }
  })

  test('a heartbeat that finds its reservation superseded aborts with the reason', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    let heartbeatTick!: () => Promise<void>
    const scope = new AdmissionScope(store, lease, (callback) => {
      heartbeatTick = callback as () => Promise<void>
      return () => {}
    })
    let releaseEffect!: () => void
    const effectGate = new Promise<void>((resolve) => (releaseEffect = resolve))
    let signalSeen!: AbortSignal
    const effect = scope.runEffect({ phase: 'sandbox-ensure', resourceKey: 'sandbox:test' }, async ({ signal }) => {
      signalSeen = signal
      await effectGate
    })
    while (!heartbeatTick || !signalSeen) await new Promise<void>((resolve) => setImmediate(resolve))
    await db
      .update(executionAdmissionReservations)
      .set({ token: crypto.randomUUID(), claimEpoch: lease.claimEpoch + 1n })
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    await heartbeatTick()
    expect(signalSeen.aborted).toBe(true)
    expect(String(signalSeen.reason)).toContain('identity-mismatch')
    releaseEffect()
    await effect.catch(() => undefined)
  })

  test('a stalled heartbeat does not block later ticks from renewing', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    let heartbeatTick!: () => Promise<void>
    let clock = 0
    const scope = new AdmissionScope(
      store,
      lease,
      (callback) => {
        heartbeatTick = callback as () => Promise<void>
        return () => {}
      },
      { heartbeatIntervalMs: 10, now: () => clock }
    )
    const originalHeartbeat = store.heartbeatEffect.bind(store)
    let releaseStalled!: () => void
    const stalled = new Promise<void>((resolve) => (releaseStalled = resolve))
    let calls = 0
    store.heartbeatEffect = async (...args) => {
      calls += 1
      if (calls === 1) {
        await stalled
        return originalHeartbeat(...args)
      }
      return originalHeartbeat(...args)
    }
    try {
      let releaseEffect!: () => void
      const effectGate = new Promise<void>((resolve) => (releaseEffect = resolve))
      const effect = scope.runEffect({ phase: 'sandbox-ensure', resourceKey: 'sandbox:test' }, () => effectGate)
      while (!heartbeatTick) await new Promise<void>((resolve) => setImmediate(resolve))
      const [before] = await db
        .select({ leaseExpiresAt: executionAdmissionReservations.leaseExpiresAt })
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      void heartbeatTick() // stalls
      clock = 10
      void heartbeatTick() // within the stall budget: skipped
      expect(calls).toBe(1)
      clock = 25 // beyond two intervals: a fresh heartbeat must start
      await heartbeatTick()
      expect(calls).toBe(2)
      const [renewed] = await db
        .select({ leaseExpiresAt: executionAdmissionReservations.leaseExpiresAt })
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      expect(renewed!.leaseExpiresAt!.getTime()).toBeGreaterThan(before!.leaseExpiresAt!.getTime())
      releaseStalled()
      releaseEffect()
      await effect
    } finally {
      store.heartbeatEffect = originalHeartbeat
    }
  })

  test('a row marked unknown is repaired by the next matching heartbeat and its lease extended', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    let heartbeatTick!: () => Promise<void>
    const scope = new AdmissionScope(store, lease, (callback) => {
      heartbeatTick = callback as () => Promise<void>
      return () => {}
    })
    let releaseEffect!: () => void
    const effectGate = new Promise<void>((resolve) => (releaseEffect = resolve))
    let signalSeen!: AbortSignal
    const effect = scope.runEffect({ phase: 'sandbox-ensure', resourceKey: 'sandbox:test' }, async ({ signal }) => {
      signalSeen = signal
      await effectGate
    })
    while (!heartbeatTick || !signalSeen) await new Promise<void>((resolve) => setImmediate(resolve))
    await db
      .update(executionAdmissionReservations)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(await store.markExpiredOpenEffectsUnknown()).toBe(1)

    await heartbeatTick()

    expect(signalSeen.aborted).toBe(false)
    const [repaired] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(repaired.state).toBe('starting')
    expect(repaired.phase).toBe('sandbox-ensure')
    expect(repaired.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now())
    releaseEffect()
    await effect
    const [finished] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(finished).toMatchObject({ state: 'requested', phase: 'none' })
  })

  test('a heartbeat never resurrects an unknown row that recovery already settled', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    await db
      .update(executions)
      .set({ runnerClaimToken: lease.token, runnerClaimGeneration: lease.generation })
      .where(eq(executions.id, execution.id))
    expect(await store.adoptLease(lease)).toBe(true)
    const session = await store.beginWritePhase(lease, 'session-create', 'session:test')
    expect(await store.finishWritePhase(lease, session!, 'running')).toBe(true)
    const phase = await store.beginWritePhase(lease, 'agent-session', 'execution:test')
    expect(phase?.state).toBe('starting')
    await db
      .update(executionAdmissionReservations)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(await store.markExpiredOpenEffectsUnknown()).toBe(1)
    // The test store's incarnation holds no liveness lock, so recovery proves it dead.
    const recovered = await new AdmissionReservationStore(
      'recovery',
      crypto.randomUUID()
    ).recoverDeadOwnerRuntimeEffects()
    expect(recovered.map((entry) => entry.executionId)).toContain(execution.id)
    const [before] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    // Recovery handed the admission back to the queue and cleared the identity.
    expect(before.state).toBe('queued')
    expect(before.token).toBeNull()

    const outcome = await store.heartbeatEffect(lease, phase!)

    expect(outcome).toMatchObject({ ok: false, reason: 'identity-mismatch' })
    expect(await store.finishWritePhase(lease, phase!, 'running')).toBe(false)
    const [after] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(after).toEqual(before)
  })

  test('finishWritePhase repairs an unknown phase with the exact identity so settlement can begin', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    const session = await store.beginWritePhase(lease, 'session-create', 'session:test')
    expect(await store.finishWritePhase(lease, session!, 'running')).toBe(true)
    const agentSession = await store.beginWritePhase(lease, 'agent-session', 'execution:test')
    await db
      .update(executionAdmissionReservations)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(await store.markExpiredOpenEffectsUnknown()).toBe(1)

    expect(await store.finishWritePhase(lease, agentSession!, 'running')).toBe(true)
    const [running] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(running).toMatchObject({ state: 'running', phase: 'none' })
    expect(running.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now())

    const settlement = await store.beginWritePhase(lease, 'settlement', 'execution:test:settlement')
    expect(settlement?.state).toBe('starting')
    expect(settlement?.phase).toBe('settlement')
    expect(await store.finishWritePhase(lease, settlement!, 'settling')).toBe(true)
  })

  test('finishWritePhase does not repair an unknown row whose phase sequence moved on', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    const phase = await store.beginWritePhase(lease, 'sandbox-ensure', 'sandbox:test')
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'unknown', phaseSequence: phase!.phaseSequence + 1 })
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    expect(await store.finishWritePhase(lease, phase!, 'requested')).toBe(false)
    expect((await store.heartbeatEffect(lease, phase!)).ok).toBe(false)
  })

  test('expired open effects become unknown instead of being treated as safely revoked', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    await store.beginWritePhase(lease, 'sandbox-ensure', 'sandbox:test')
    await db
      .update(executionAdmissionReservations)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    expect(await store.markExpiredOpenEffectsUnknown()).toBe(1)
    const [reservation] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(reservation.state).toBe('unknown')
  })

  test('pause acquisition durably revokes a pre-external reservation', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)

    await new MaintenanceStore().setAdminHold({ active: true, actor: 'test' })

    const [reservation] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.token, lease.token))
    expect(reservation?.state).toBe('revoked')
  })

  test('refuses a phase from a provisional reservation without misclassifying it', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const lease = await store.createProvisional(execution.id)
    await db
      .update(instanceMaintenanceState)
      .set({ adminHold: true, generation: lease.generation + 1 })
      .where(eq(instanceMaintenanceState.id, 'global'))

    expect(await store.beginWritePhase(lease, 'sandbox-ensure', 'sandbox:test')).toBeNull()
    const [reservation] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(
        and(
          eq(executionAdmissionReservations.executionId, execution.id),
          eq(executionAdmissionReservations.token, lease.token)
        )
      )
    expect(reservation?.state).toBe('provisional')
  })
})
