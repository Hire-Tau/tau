import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { agents, db, executionAdmissionReservations, executions, instanceMaintenanceState } from '../../db'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'
import {
  AdmissionEffectRefusedError,
  AdmissionReservationStore,
  AdmissionScope,
  admissionEffectPhaseFromError,
  NestedAdmissionEffectError,
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

const REFUSAL_MESSAGE = 'Admission effect was refused by the durable fence'

async function setupAdoptedScope() {
  const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
  const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
  const lease = await store.createProvisional(execution.id)
  expect(await store.adoptLease(lease)).toBe(true)
  return { execution, lease, scope: new AdmissionScope(store, lease) }
}

describe('AdmissionScope typed refusal errors', () => {
  test('a closed fence refuses the effect with the typed error and a byte-identical message', async () => {
    const { scope } = await setupAdoptedScope()
    await new MaintenanceStore().setAdminHold({ active: true, actor: 'test' })

    const promise = scope.runEffect({ phase: 'sandbox-ensure', resourceKey: 'sandbox:test' }, async () => {})
    // The message is exactly today's prose so INTERNAL_EXECUTION_ERROR_MARKERS and
    // existing log greps keep matching.
    await expect(promise).rejects.toBeInstanceOf(AdmissionEffectRefusedError)
    const error = (await promise.catch((reason: unknown) => reason)) as AdmissionEffectRefusedError
    expect(error.message).toBe(REFUSAL_MESSAGE)
    expect(error.phase).toBe('sandbox-ensure')
    expect(error.refusal).toBe('fence-closed')
  })

  test('a lost lease refuses the effect with the typed error and a lease-lost refusal', async () => {
    const { lease, scope } = await setupAdoptedScope()
    // Someone else took the reservation over: the exact lease identity no longer
    // matches, so no phase can begin for this owner.
    await db
      .update(executionAdmissionReservations)
      .set({ token: crypto.randomUUID(), claimEpoch: lease.claimEpoch + 1n })
      .where(eq(executionAdmissionReservations.executionId, lease.executionId))

    const promise = scope.runEffect({ phase: 'session-create', resourceKey: 'execution:test' }, async () => {})
    await expect(promise).rejects.toBeInstanceOf(AdmissionEffectRefusedError)
    const error = (await promise.catch((reason: unknown) => reason)) as AdmissionEffectRefusedError
    expect(error.message).toBe(REFUSAL_MESSAGE)
    expect(error.executionId).toBe(lease.executionId)
    expect(error.refusal).toBe('lease-lost')
  })

  test('an operation failure inside a platform phase carries its phase structurally', async () => {
    const { scope } = await setupAdoptedScope()
    const adapterError = new Error('sandbox adapter rejected')

    const promise = scope.runEffect({ phase: 'sandbox-ensure', resourceKey: 'sandbox:test' }, async () => {
      throw adapterError
    })
    await expect(promise).rejects.toBe(adapterError)
    expect(admissionEffectPhaseFromError(adapterError)).toBe('sandbox-ensure')
  })

  test('a non-Error throw inside a platform phase is normalized and still carries its phase', async () => {
    const { scope } = await setupAdoptedScope()

    const promise = scope.runEffect({ phase: 'toolchain-reconcile', resourceKey: 'sandbox:test' }, async () => {
      throw 'adapter exploded'
    })
    const error = await promise.catch((reason: unknown) => reason as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('adapter exploded')
    expect(admissionEffectPhaseFromError(error)).toBe('toolchain-reconcile')
  })

  test('nested effects still throw NestedAdmissionEffectError and phase context never leaks to other errors', async () => {
    const { scope } = await setupAdoptedScope()
    let releaseOuter!: () => void
    const outerGate = new Promise<void>((resolve) => (releaseOuter = resolve))
    const outer = scope.runEffect({ phase: 'sandbox-ensure', resourceKey: 'sandbox:test' }, () => outerGate)
    while (true) {
      const [row] = await db
        .select({ phase: executionAdmissionReservations.phase })
        .from(executionAdmissionReservations)
      if (row?.phase === 'sandbox-ensure') break
      await Promise.resolve()
    }

    const nested = scope.runEffect({ phase: 'toolchain-reconcile', resourceKey: 'sandbox:test' }, async () => {})
    await expect(nested).rejects.toBeInstanceOf(NestedAdmissionEffectError)
    // The nested refusal happens before any phase begins, so no phase context is attached.
    const nestedError = await nested.catch((reason: unknown) => reason as Error)
    expect(admissionEffectPhaseFromError(nestedError)).toBeUndefined()
    releaseOuter()
    await outer
  })

  test('an unrelated error carries no phase context', () => {
    expect(admissionEffectPhaseFromError(new Error('unrelated'))).toBeUndefined()
    expect(admissionEffectPhaseFromError('not an error')).toBeUndefined()
    expect(admissionEffectPhaseFromError(null)).toBeUndefined()
  })
})
