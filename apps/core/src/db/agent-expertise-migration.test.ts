import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'
import { mergeRetiredFlowPrompt } from './agent-expertise-backfill'
import { workflowFingerprint } from '../services/workflows/catalog'

const rollout = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') }).find((migration) =>
  migration.sql.join('\n').includes('ALTER TABLE "agent_types" DROP COLUMN "flow_prompt"')
)!
// Exercise the historical backfill stage independently of later rollout DDL.
const target = {
  ...rollout,
  sql: rollout.sql.filter((sql) => sql.includes('ALTER TABLE "agent_types" DROP COLUMN "flow_prompt"')),
}
const id = crypto.randomUUID()
const profile = {
  id: 'worker',
  systemPrompt: 'Pinned expertise',
  flowPrompt: 'Pinned addition',
  toolsDeny: ['example'],
}
const merged = { id: 'worker', systemPrompt: 'Pinned expertise\n\nPinned addition', toolsDeny: ['example'] }
const bindingKey = `worker:${workflowFingerprint(profile)}:reuse-0`

function urlFor(name: string) {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

test('merging retired expertise keeps existing content and avoids duplicate addenda', () => {
  expect(mergeRetiredFlowPrompt(profile)).toEqual(merged)
  expect(mergeRetiredFlowPrompt({ ...merged, flowPrompt: 'Pinned addition' })).toEqual(merged)
  expect(mergeRetiredFlowPrompt({ systemPrompt: 'Original', flowPrompt: null })).toEqual({ systemPrompt: 'Original' })
})

describe.each(['standalone', 'Drizzle startup'] as const)('remove flowPrompt migration (%s)', (mode) => {
  const databaseName = `expertise_${crypto.randomUUID().replaceAll('-', '')}`
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql
  beforeAll(async () => {
    expect(target).toBeDefined()
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
    client = createPostgresConnection(urlFor(databaseName), { max: 1, onnotice: () => {} })
    if (mode === 'Drizzle startup') drizzle(client)
    connection = await client.reserve()
    // Minimal historical tables let the real runner exercise the generated DDL,
    // preservation hook, ledger, and rollback without using the current schema.
    await connection.unsafe(`
      CREATE TABLE agent_types (id text PRIMARY KEY, system_prompt text NOT NULL, flow_prompt text, yaml_template jsonb, yaml_field_overrides jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE work_stream_flow_runs (work_stream_id uuid PRIMARY KEY, profiles jsonb NOT NULL);
      CREATE TABLE work_style_bindings (agent_id uuid PRIMARY KEY, binding_key text NOT NULL, profile jsonb NOT NULL);
    `)
    await connection`INSERT INTO agent_types (id,system_prompt,flow_prompt,yaml_template,yaml_field_overrides)
      VALUES ('worker','Current expertise','Current addition',${JSON.stringify({ systemPrompt: 'Template expertise', flowPrompt: 'Template addition' })}::text::jsonb,'["name","flowPrompt"]'),
      ('plain','Plain expertise',NULL,NULL,'[]')`
    await connection`INSERT INTO work_stream_flow_runs VALUES (${id},${JSON.stringify({ worker: profile, 'attempt:1': profile })}::text::jsonb)`
    await connection`INSERT INTO work_style_bindings VALUES (${id},${bindingKey},${JSON.stringify(profile)}::text::jsonb)`
  })
  afterAll(async () => {
    connection?.release()
    await client?.end()
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      await admin.end()
    }
  })

  test('preserves catalog and pinned expertise atomically, drops the column, and keeps session reuse keys', async () => {
    await expect(
      applyMigrations(connection, { ...target, sql: [...target.sql, 'SELECT * FROM deliberately_missing_relation'] })
    ).rejects.toThrow()
    const [rolledBack] = await connection`SELECT system_prompt,flow_prompt FROM agent_types WHERE id='worker'`
    expect(rolledBack).toEqual({ system_prompt: 'Current expertise', flow_prompt: 'Current addition' })
    const [oldBinding] = await connection`SELECT binding_key,profile FROM work_style_bindings WHERE agent_id=${id}`
    expect(oldBinding).toEqual({ binding_key: bindingKey, profile })

    await applyMigrations(connection, target)
    const [row] = await connection`SELECT * FROM agent_types WHERE id='worker'`
    expect(row).toMatchObject({
      system_prompt: 'Current expertise\n\nCurrent addition',
      yaml_template: { systemPrompt: 'Template expertise\n\nTemplate addition' },
      yaml_field_overrides: ['name', 'systemPrompt'],
    })
    expect(row).not.toHaveProperty('flow_prompt')
    const [plain] = await connection`SELECT * FROM agent_types WHERE id='plain'`
    expect(plain).toMatchObject({ system_prompt: 'Plain expertise', yaml_template: null, yaml_field_overrides: [] })
    const [run] = await connection`SELECT profiles FROM work_stream_flow_runs WHERE work_stream_id=${id}`
    expect(run!.profiles).toEqual({ worker: merged, 'attempt:1': merged })
    const [binding] = await connection`SELECT binding_key,profile FROM work_style_bindings WHERE agent_id=${id}`
    expect(binding).toEqual({ binding_key: `worker:${workflowFingerprint(merged)}:reuse-0`, profile: merged })

    await applyMigrations(connection, target)
    const [again] = await connection`SELECT system_prompt FROM agent_types WHERE id='worker'`
    expect(again!.system_prompt).toBe('Current expertise\n\nCurrent addition')
  })
})
