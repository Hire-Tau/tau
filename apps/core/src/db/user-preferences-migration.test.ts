import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'CREATE TABLE "user_preferences"'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `theme_prefs_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

const userId = '50000000-0000-4000-8000-000000000001'

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('account theme migration (real runner, isolated database)', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql

  beforeAll(async () => {
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('preserves users, stores a preference document atomically, is idempotent and cascades deletes', async () => {
    expect(target).toBeDefined()
    await applyMigrations(connection, predecessors)
    await connection.unsafe(`INSERT INTO users (id, email) VALUES ('${userId}', 'theme-migration@example.test')`)
    await applyMigrations(connection, [...predecessors, target!])
    await applyMigrations(connection, [...predecessors, target!])
    expect(await connection.unsafe('SELECT * FROM user_preferences')).toHaveLength(0)
    expect(await connection.unsafe('SELECT id FROM users')).toHaveLength(1)
    const theme = { themeId: 'harbor', appearance: 'system', customTheme: null }
    await connection.unsafe('INSERT INTO user_preferences (user_id, theme) VALUES ($1, $2::text::jsonb)', [
      userId,
      JSON.stringify(theme),
    ])
    const [row] = await connection.unsafe('SELECT * FROM user_preferences')
    expect(row.theme).toEqual(theme)
    expect(row.updated_at).toBeInstanceOf(Date)
    await connection.unsafe('DELETE FROM users WHERE id = $1', [userId])
    expect(await connection.unsafe('SELECT * FROM user_preferences')).toHaveLength(0)
  })
})
