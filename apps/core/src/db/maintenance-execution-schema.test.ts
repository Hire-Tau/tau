import { describe, expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { executionStatusEnum, executions } from './schema'

describe('maintenance-waiting execution schema', () => {
  test('persists maintenance provenance and indexes parked executions in FIFO order', () => {
    expect(executionStatusEnum.enumValues).toContain('waiting-maintenance')
    expect(executions.maintenanceGeneration).toBeDefined()
    expect(executions.maintenanceQueuedAt).toBeDefined()
    expect((executions.maintenanceQueuedAt as unknown as { withTimezone: boolean }).withTimezone).toBe(true)

    const index = getTableConfig(executions).indexes.find(
      (candidate) => candidate.config.name === 'idx_executions_waiting_maintenance_fifo'
    )
    expect(index?.config.columns.map((column) => (column as { name: string }).name)).toEqual(['started_at', 'id'])
    expect(index?.config.where).toBeDefined()
    expect(index?.config.concurrently).toBe(true)
  })
})
