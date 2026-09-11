import { describe, expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import * as schema from './schema'

function partialIndexPredicate(where: unknown): string {
  if (!where || typeof where !== 'object' || !('queryChunks' in where)) return ''

  return (where.queryChunks as unknown[])
    .map((chunk) => {
      if (!chunk || typeof chunk !== 'object') return ''
      if ('name' in chunk && typeof chunk.name === 'string') return chunk.name
      if ('value' in chunk && Array.isArray(chunk.value)) return chunk.value.join('')
      return ''
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('fleet alert schema', () => {
  test('exports durable incident and notification ledgers', () => {
    expect(schema.executions.runStartedAt).toBeDefined()
    expect(schema.inbox.idempotencyKey).toBeDefined()
    expect(schema.fleetIncidents).toBeDefined()
    expect(schema.fleetIncidents.accountId).toBeDefined()
    expect(schema.fleetIncidents.healthKind).toBeDefined()
    expect(schema.fleetIncidents.providerRetryAt).toBeDefined()
    expect(schema.fleetIncidents.providerLastSuccessAt).toBeDefined()
    expect(schema.fleetIncidentNotifications).toBeDefined()
    expect(schema.fleetIncidentNotifications.audience).toBeDefined()
    expect(schema.fleetIncidentNotifications.recipientId).toBeDefined()
    expect(schema.fleetIncidentNotifications.nextAttemptAt).toBeDefined()
  })

  test('allows only one unresolved incident for a scope', () => {
    const table = schema.fleetIncidents
    expect(table).toBeDefined()
    if (!table) return

    const incidentScope = getTableConfig(table).indexes.find(
      (candidate) => candidate.config.name === 'idx_fleet_incidents_one_open_scope'
    )
    expect(incidentScope?.config.unique).toBe(true)
    expect(incidentScope?.config.columns.map((column) => (column as { name: string }).name)).toEqual([
      'kind',
      'scope_key',
    ])
    expect(partialIndexPredicate(incidentScope?.config.where)).toBe('resolved_at IS NULL')
  })

  test('deduplicates incident transitions and non-null inbox keys', () => {
    const notifications = schema.fleetIncidentNotifications
    expect(notifications).toBeDefined()
    if (!notifications) return

    const notificationConfig = getTableConfig(notifications)
    expect(
      notificationConfig.uniqueConstraints.some(
        (constraint) => constraint.columns.map((column) => column.name).join(',') === 'incident_id,kind,audience'
      )
    ).toBe(true)

    expect(
      notificationConfig.uniqueConstraints.some(
        (constraint) => constraint.columns.map((column) => column.name).join(',') === 'idempotency_key'
      )
    ).toBe(true)

    const dueIndex = notificationConfig.indexes.find(
      (candidate) => candidate.config.name === 'idx_fleet_incident_notifications_due'
    )
    expect(dueIndex?.config.columns.map((column) => (column as { name: string }).name)).toEqual([
      'status',
      'next_attempt_at',
      'claimed_at',
    ])
    expect(schema.inbox.idempotencyKey.isUnique).toBe(true)
  })
})
