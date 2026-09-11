import { afterEach, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { agents, squads } from '../db/schema'
import { agentListQuery, listAgentRows } from './agent-queries'
import { ensureQueryIndex } from '../test-utils/message-query-indexes'

const squadIds: string[] = []
afterEach(async () => {
  for (const squadId of squadIds.splice(0)) await db.delete(squads).where(eq(squads.id, squadId))
})

test('top-level live and addressable lists stay selective with historical agents, including generic plans', async () => {
  await ensureQueryIndex('idx_agents_parent_agent_id')
  await ensureQueryIndex('idx_agents_squad_id')
  await ensureQueryIndex('idx_agents_top_level_squad_status_created')
  const [squad] = await db
    .insert(squads)
    .values({ name: `agent-cost-${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  squadIds.push(squad.id)
  const [parent] = await db
    .insert(agents)
    .values({ squadId: squad.id, agentTypeId: 'engineer', status: 'terminated' })
    .returning()
  await db.execute(sql`INSERT INTO agents(squad_id,agent_type_id,status,parent_agent_id,metadata,created_at)
    SELECT ${squad.id}::uuid,'engineer',
      CASE WHEN n<=40 THEN 'idle' WHEN n<=60 THEN 'dormant' ELSE 'terminated' END::agent_status,
      CASE WHEN n>4000 THEN ${parent.id}::uuid END,
      jsonb_build_object('test',repeat(md5(n::text),30)),
      '2026-01-01'::timestamp + n * interval '1 second'
    FROM generate_series(1,12000) n`)
  await db.execute(sql`ANALYZE agents`)
  const live = await listAgentRows({ squadId: squad.id, topLevelOnly: true, live: true })
  const addressable = await listAgentRows({ squadId: squad.id, topLevelOnly: true, addressable: true })
  expect(live).toHaveLength(40)
  expect(addressable).toHaveLength(60)
  expect(live.every((row) => row.parentAgentId === null && row.status === 'idle')).toBe(true)
  expect(addressable.map((row) => row.createdAt.getTime())).toEqual(
    addressable.map((row) => row.createdAt.getTime()).sort((a, b) => a - b)
  )
  for (const mode of ['force_custom_plan', 'force_generic_plan']) {
    for (const filter of [{ live: true }, { addressable: true }]) {
      const compiled = agentListQuery({ squadId: squad.id, topLevelOnly: true, ...filter }).toSQL()
      expect(compiled.params).toEqual([squad.id, 2147483647])
      const statementName = `agent_cost_${crypto.randomUUID().replaceAll('-', '')}`
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL plan_cache_mode=${mode}`))
        await tx.execute(sql.raw(`PREPARE ${statementName}(uuid,int) AS ${compiled.sql}`))
        try {
          const [explained] = await tx.execute(
            sql.raw(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE ${statementName}('${squad.id}',2147483647)`)
          )
          const plan = (explained['QUERY PLAN'] as any)[0].Plan
          expect(JSON.stringify(plan)).toContain('idx_agents_top_level_squad_status_created')
          expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(150)
        } finally {
          await tx.execute(sql.raw(`DEALLOCATE ${statementName}`))
        }
      })
    }
  }
  const rollback = new Error('restore agent list index')
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`DROP INDEX idx_agents_top_level_squad_status_created`)
      const [explained] = await tx.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM agents
      WHERE squad_id=${squad.id} AND parent_agent_id IS NULL AND status IN ('idle','active','waiting-input','compacting','resetting')
      ORDER BY created_at,id LIMIT 2147483647`)
      const plan = (explained['QUERY PLAN'] as any)[0].Plan
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeGreaterThan(150)
      throw rollback
    })
  ).rejects.toBe(rollback)
})
