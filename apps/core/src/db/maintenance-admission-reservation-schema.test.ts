import { describe, expect, test } from 'bun:test'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import { executionAdmissionReservations, instanceMaintenanceState } from './schema'

describe('maintenance admission reservation schema', () => {
  test('persists holder revision and fail-closed durable reservation identity', () => {
    expect(instanceMaintenanceState.holderRevision).toBeDefined()
    const config = getTableConfig(executionAdmissionReservations)
    expect(config.name).toBe('execution_admission_reservations')
    expect(executionAdmissionReservations.token).toBeDefined()
    expect(executionAdmissionReservations.claimEpoch).toBeDefined()
    expect(executionAdmissionReservations.ownerIncarnation).toBeDefined()
    expect(executionAdmissionReservations.admittedGeneration).toBeDefined()
    expect(executionAdmissionReservations.admittedHolderRevision).toBeDefined()
    expect(executionAdmissionReservations.state).toBeDefined()
    expect(executionAdmissionReservations.phaseSequence).toBeDefined()
  })

  test('requires a primary owner in every lease-required state', () => {
    const config = getTableConfig(executionAdmissionReservations)
    const constraint = config.checks.find(
      (candidate) => candidate.name === 'execution_admission_reservation_nonqueue_owner_required'
    )

    expect(constraint).toBeDefined()
    const predicate = new PgDialect().sqlToQuery(constraint!.value).sql
    expect(predicate).toContain(
      `"execution_admission_reservations"."state" IN ('queued', 'waiting-maintenance', 'released', 'revoked')`
    )
    expect(predicate).toContain('"execution_admission_reservations"."owner_id" IS NOT NULL')
  })

  test('reserves one current execution per agent before worker ownership exists', () => {
    const config = getTableConfig(executionAdmissionReservations)
    expect(executionAdmissionReservations.agentId).toBeDefined()

    const currentAgent = config.indexes.find(
      (candidate) => candidate.config.name === 'idx_execution_admission_reservations_agent_current'
    )
    expect(currentAgent?.config.unique).toBe(true)
    expect(currentAgent?.config.columns.map((column) => (column as { name: string }).name)).toEqual(['agent_id'])
    expect(currentAgent?.config.where).toBeDefined()

    // Queue ownership belongs to the database, not a fictitious worker. The
    // exact token/epoch/owner/incarnation/lease are populated together only
    // when pickup upgrades the canonical row to provisional.
    expect(executionAdmissionReservations.token.notNull).toBe(false)
    expect(executionAdmissionReservations.claimEpoch.notNull).toBe(false)
    expect(executionAdmissionReservations.ownerId.notNull).toBe(false)
    expect(executionAdmissionReservations.ownerIncarnation.notNull).toBe(false)
    expect(executionAdmissionReservations.admittedGeneration.notNull).toBe(false)
    expect(executionAdmissionReservations.admittedHolderRevision.notNull).toBe(false)
    expect(executionAdmissionReservations.leaseExpiresAt.notNull).toBe(false)
    expect(executionAdmissionReservations.lastHeartbeatAt.notNull).toBe(false)
  })
})
