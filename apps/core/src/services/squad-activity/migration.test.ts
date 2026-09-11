import { describe, expect, test } from 'bun:test'

const migrationPath = new URL('../../../drizzle/0131_redundant_shriek.sql', import.meta.url)

describe('Activity owner-set migration', () => {
  test('is additive and preserves retained legacy GitHub Activity projections', async () => {
    const sql = await Bun.file(migrationPath).text()
    expect(sql).toContain('ADD COLUMN "activity_squad_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL')
    expect(sql).not.toMatch(/\b(?:DELETE|UPDATE)\s+(?:FROM\s+)?"?squad_activity"?/i)
    expect(sql).not.toMatch(/\b(?:DELETE|UPDATE)\s+(?:FROM\s+)?"?integration_event_polling_dispatches"?/i)
  })
})
