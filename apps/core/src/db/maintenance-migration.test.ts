import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { sql } from 'drizzle-orm'
import { db } from './index'
import { MONOREPO_ROOT } from '../lib/paths'
import { applyMigrations, classifyMigration } from './migrator'
import { createPostgresConnection } from './connection'
import { acquireMaintenanceTestIsolation } from '../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
beforeAll(async () => (releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()))
afterAll(() => releaseMaintenanceIsolation?.())

const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })

describe('maintenance online migration lineage', () => {
  test('recreates execution_status before dependent transactional schema uses the new value', () => {
    const migration = migrations.find((candidate) => candidate.sql.join('\n').includes('execution_status_old'))
    expect(migration).toBeDefined()
    expect(classifyMigration(migration!)).toEqual({ kind: 'transactional' })
    const statements = migration!.sql.join('\n')
    expect(statements).toContain('ALTER TYPE "public"."execution_status" RENAME TO "execution_status_old"')
    expect(statements).toContain('CREATE TYPE "public"."execution_status" AS ENUM')
    expect(statements).toContain('ALTER COLUMN "status" TYPE "public"."execution_status"')
    expect(statements).toContain('DROP TYPE "public"."execution_status_old"')
    expect(statements).not.toContain('ADD VALUE')
  })

  for (const indexName of ['idx_executions_waiting_maintenance_fifo', 'idx_messages_agent_client_id_unique']) {
    test(`${indexName} is an isolated concurrent migration and exists with its predicate`, async () => {
      const matches = migrations.filter((candidate) => candidate.sql.join('\n').includes(`"${indexName}"`))
      expect(matches).toHaveLength(1)
      expect(matches[0]!.sql).toHaveLength(1)
      expect(classifyMigration(matches[0]!)).toMatchObject({ kind: 'concurrent-index', indexName })

      const client = createPostgresConnection(process.env.DATABASE_URL!, { max: 1 })
      const connection = await client.reserve()
      const ledgerSchema = `maintenance_index_${crypto.randomUUID().replaceAll('-', '')}`
      try {
        await connection.unsafe(`DROP INDEX IF EXISTS "${indexName}"`)
        await applyMigrations(connection, matches[0]!, { migrationsSchema: ledgerSchema })
        const result = await connection<{ indexdef: string }[]>`
          SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${indexName}
        `
        expect(result).toHaveLength(1)
        expect(result[0]!.indexdef).toContain(' WHERE ')
        if (indexName === 'idx_messages_agent_client_id_unique') {
          expect(result[0]!.indexdef).toContain('UNIQUE INDEX')
          expect(result[0]!.indexdef).toContain("metadata ->> 'clientId'")
        } else {
          expect(result[0]!.indexdef).toContain('started_at')
          expect(result[0]!.indexdef).toContain("status = 'waiting-maintenance'")
        }
      } finally {
        await connection.unsafe(`DROP INDEX IF EXISTS "${indexName}"`)
        await connection.unsafe(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`)
        connection.release()
        await client.end()
      }
    })
  }

  test('does not deploy a validating provenance check on the executions hot table', async () => {
    const result = await db.execute<{ present: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'executions_maintenance_provenance_check'
      ) AS present
    `)
    expect(result[0]?.present).toBe(false)
  })
})
