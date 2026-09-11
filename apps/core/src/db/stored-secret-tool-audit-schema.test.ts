import { expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { storedSecretToolAudits } from './schema'

test('stored-secret tool audits cannot store secret-derived material', () => {
  const table = getTableConfig(storedSecretToolAudits)
  expect(table.columns.map((column) => column.name)).toEqual([
    'id',
    'agent_id',
    'execution_id',
    'secret_key',
    'outcome',
    'created_at',
  ])
  expect(table.foreignKeys).toHaveLength(0)
  expect(table.columns.some((column) => /value|payload|body|hash|probe|tool_call|error/.test(column.name))).toBe(false)
  expect(table.indexes.some((index) => index.config.name === 'idx_stored_secret_tool_audits_execution_created')).toBe(
    true
  )
})
