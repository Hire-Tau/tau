import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { db, instanceMaintenanceAudit, instanceMaintenanceState } from '../../db'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'
import { assertMaintenanceAdmissionOpen, MaintenanceAdmissionPaused } from './admission'
import { MaintenanceStore } from './store'

let releaseIsolation: (() => Promise<void>) | undefined
const store = new MaintenanceStore()
beforeAll(async () => (releaseIsolation = await acquireMaintenanceTestIsolation()))
afterAll(() => releaseIsolation?.())
beforeEach(async () => {
  await db.delete(instanceMaintenanceAudit)
  await db.delete(instanceMaintenanceState)
  await store.initialize()
})

describe('maintenance admission', () => {
  test('throws a typed structured deferral while maintenance is authoritative', async () => {
    const paused = await store.setAdminHold({ active: true, actor: 'test' })
    const error = await assertMaintenanceAdmissionOpen().catch((caught) => caught)
    expect(error).toBeInstanceOf(MaintenanceAdmissionPaused)
    expect(error.generation).toBe(paused.generation)
    expect(error.evidence).toEqual({
      origin: 'authoritative-refresh',
      generation: paused.generation,
      blockers: [{ kind: 'admin', idHash: '9f86d081884c' }],
      subject: null,
    })
  })
})
