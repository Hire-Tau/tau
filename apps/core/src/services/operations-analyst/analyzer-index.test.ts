import { expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { join } from 'path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { db } from '../../db'
import { agents, squads } from '../../db/schema'
import { createPostgresConnection } from '../../db/connection'
import { applyMigrations, classifyMigration } from '../../db/migrator'
import { MONOREPO_ROOT } from '../../lib/paths'

test('stream-group prefix query uses selective pattern index at realistic volume', async () => {
  const client = createPostgresConnection(process.env.DATABASE_URL!, { max: 1 })
  const connection = await client.reserve()
  const ledgerSchema = `analyzer_index_${crypto.randomUUID().replaceAll('-', '')}`
  let lockHeld = false
  let squadId: string | undefined
  let agentId: string | undefined
  try {
    await connection`SELECT pg_advisory_lock(8675309)`
    lockHeld = true
    const [squad] = await db
      .insert(squads)
      .values({ name: `index-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadId = squad.id
    const [agent] = await db.insert(agents).values({ squadId, agentTypeId: 'engineer' }).returning()
    agentId = agent.id

    const migration = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') }).find(
      (item) => {
        const classification = classifyMigration(item)
        return (
          classification.kind === 'concurrent-index' &&
          classification.indexName === 'idx_messages_agent_stream_group_pattern'
        )
      }
    )
    expect(migration).toBeDefined()
    await connection.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "public"."idx_messages_agent_stream_group_pattern"')
    await applyMigrations(connection, migration!, { migrationsSchema: ledgerSchema })

    await db.execute(sql`INSERT INTO messages (agent_id, role, content, metadata)
      SELECT ${agentId}::uuid,
             'assistant'::message_role,
             '',
             jsonb_build_object('streamGroupId', CASE WHEN n <= 5
               THEN '00000000-0000-4000-8000-000000000001:' || n::text
               ELSE lpad((n % 10000)::text, 8, '0') || '-0000-4000-8000-000000000999:' || n::text END)
      FROM generate_series(1, 100000) n`)
    await db.execute(sql`ANALYZE messages`)
    const explained = await connection.unsafe<{ 'QUERY PLAN': unknown }[]>(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
       SELECT * FROM messages
       WHERE agent_id = $1 AND role = 'assistant'
         AND metadata->>'streamGroupId' LIKE '00000000-0000-4000-8000-000000000001:%'`,
      [agentId]
    )
    const document = explained[0]?.['QUERY PLAN'] as [{ Plan: Record<string, unknown> }]
    if (process.env.OPS_ANALYST_PRINT_EXPLAIN === '1') console.log(JSON.stringify(document, null, 2))
    const nodes: Record<string, unknown>[] = []
    const visit = (node: Record<string, unknown>) => {
      nodes.push(node)
      for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) visit(child)
    }
    visit(document[0].Plan)
    const indexNode = nodes.find((node) => node['Index Name'] === 'idx_messages_agent_stream_group_pattern')
    expect(indexNode).toBeDefined()
    expect(String(indexNode?.['Index Cond'])).toContain('streamGroupId')
    expect(document[0].Plan['Actual Rows']).toBe(5)
    expect(Number(indexNode?.['Rows Removed by Filter'] ?? 0)).toBeLessThan(1000)
    expect(Number(indexNode?.['Shared Read Blocks'] ?? 0) + Number(indexNode?.['Shared Hit Blocks'] ?? 0)).toBeLessThan(
      5000
    )
  } finally {
    try {
      if (squadId) await db.delete(squads).where(eq(squads.id, squadId))
      await connection.unsafe(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`)
    } finally {
      if (lockHeld) await connection`SELECT pg_advisory_unlock(8675309)`
      connection.release()
      await client.end()
    }
  }
}, 30_000)
