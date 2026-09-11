import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type postgres from 'postgres'
import { asc, eq } from 'drizzle-orm'
import { db } from './index'
import { agents, agentTypes, messages } from './schema'
import { AgentType } from '../entities/AgentType'
import { Agent } from '../entities/Agent'
import { createPostgresConnection, getConnectionString } from './connection'
import { backfillMessageEnqueueOrder } from './message-enqueue-order-backfill'

const typeId = `enqueue-backfill-${crypto.randomUUID()}`

describe('message enqueue order backfill', () => {
  beforeAll(async () => {
    await AgentType.create({ id: typeId, name: 'Backfill', model: 'test:model', systemPrompt: 'test' })
  })

  afterAll(async () => {
    const ownedAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.agentTypeId, typeId))
    for (const owned of ownedAgents) await db.delete(messages).where(eq(messages.agentId, owned.id))
    await db.delete(agents).where(eq(agents.agentTypeId, typeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
  })

  async function withConnection<T>(run: (connection: postgres.ReservedSql) => Promise<T>) {
    const client = createPostgresConnection(getConnectionString())
    const connection = await client.reserve()
    try {
      return await run(connection)
    } finally {
      connection.release()
      await client.end()
    }
  }

  it('rejects invalid batch sizes before querying', async () => {
    for (const batchSize of [0, -1, 1.5, 10_001, Number.NaN]) {
      await expect(backfillMessageEnqueueOrder({} as never, { batchSize })).rejects.toThrow(
        'batchSize must be an integer between 1 and 10000'
      )
    }
  })

  it('uses only EXISTS and indexed sequence checks after installation', async () => {
    const statements: string[] = []
    const connection = {
      unsafe: async (statement: string) => {
        statements.push(statement)
        return statements.length === 1 ? [{ has_null: false }] : [{ max_positive: '42', sequence_value: '42' }]
      },
    } as unknown as postgres.ReservedSql
    expect(await backfillMessageEnqueueOrder(connection)).toEqual({ updated: 0, batches: 0 })
    expect(statements).toHaveLength(2)
    expect(statements.join(' ')).not.toMatch(/count\s*\(|distinct|min\s*\(/i)
    expect(statements[1]).toContain('ORDER BY enqueue_order DESC')
    expect(statements[1]).toContain('LIMIT 1')
  })

  it('still detects sequence drift on the completed steady-state path', async () => {
    let query = 0
    const connection = {
      unsafe: async () => (++query === 1 ? [{ has_null: false }] : [{ max_positive: '43', sequence_value: '42' }]),
    } as unknown as postgres.ReservedSql
    await expect(backfillMessageEnqueueOrder(connection)).rejects.toThrow("SELECT setval('message_enqueue_order_seq'")
  })

  it('fills five legacy rows in three deterministic batches while preserving sequenced rows and defaults', async () => {
    const agent = await Agent.create({ agentTypeId: typeId })
    const tiedAt = new Date('2026-08-10T12:00:00.000Z')
    const ids = [
      'ffffffff-ffff-4fff-8fff-fffffffffff1',
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000003',
    ]
    for (const id of ids)
      await db.insert(messages).values({ id, agentId: agent.id, role: 'human', content: id, createdAt: tiedAt })

    const preservedId = crypto.randomUUID()
    await db.insert(messages).values({ id: preservedId, agentId: agent.id, role: 'human', content: 'preserved' })
    const [before] = await db
      .select({ order: messages.enqueueOrder })
      .from(messages)
      .where(eq(messages.id, preservedId))
    expect(before?.order).toBeGreaterThan(0n)
    await db.update(messages).set({ enqueueOrder: null }).where(eq(messages.agentId, agent.id))
    await db.update(messages).set({ enqueueOrder: before!.order }).where(eq(messages.id, preservedId))

    await withConnection(async (connection) => {
      expect(await backfillMessageEnqueueOrder(connection, { batchSize: 2 })).toEqual({ updated: 5, batches: 3 })
      expect(await backfillMessageEnqueueOrder(connection, { batchSize: 2 })).toEqual({ updated: 0, batches: 0 })
    })

    const rows = await db
      .select({ id: messages.id, order: messages.enqueueOrder })
      .from(messages)
      .where(eq(messages.agentId, agent.id))
      .orderBy(asc(messages.enqueueOrder))
    expect(rows).toEqual([
      { id: ids[2], order: -5n },
      { id: ids[4], order: -4n },
      { id: ids[3], order: -3n },
      { id: ids[1], order: -2n },
      { id: ids[0], order: -1n },
      { id: preservedId, order: before!.order },
    ])
    await db.delete(messages).where(eq(messages.agentId, agent.id))
  })

  it('resumes a contiguous partial backfill without rewriting completed rows', async () => {
    const agent = await Agent.create({ agentTypeId: typeId })
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID()).sort()
    for (const id of ids)
      await db.insert(messages).values({ id, agentId: agent.id, role: 'human', content: id, createdAt: new Date(0) })
    await db.update(messages).set({ enqueueOrder: null }).where(eq(messages.agentId, agent.id))
    await db.update(messages).set({ enqueueOrder: -5n }).where(eq(messages.id, ids[0]!))
    await db.update(messages).set({ enqueueOrder: -4n }).where(eq(messages.id, ids[1]!))

    await withConnection(async (connection) => {
      expect(await backfillMessageEnqueueOrder(connection, { batchSize: 2 })).toEqual({ updated: 3, batches: 2 })
    })
    const rows = await db
      .select({ id: messages.id, order: messages.enqueueOrder })
      .from(messages)
      .where(eq(messages.agentId, agent.id))
      .orderBy(asc(messages.enqueueOrder))
    expect(rows).toEqual(ids.map((id, index) => ({ id, order: BigInt(index - 5) })))
    await db.delete(messages).where(eq(messages.agentId, agent.id))
  })

  it('fails actionably when restored sequence state trails stored positive orders', async () => {
    const agent = await Agent.create({ agentTypeId: typeId })
    await db
      .insert(messages)
      .values({ agentId: agent.id, role: 'human', content: 'ahead', enqueueOrder: 9_000_000_000_000_002n })
    await withConnection(async (connection) => {
      await expect(backfillMessageEnqueueOrder(connection)).rejects.toThrow("SELECT setval('message_enqueue_order_seq'")
    })
    await db.delete(messages).where(eq(messages.agentId, agent.id))
  })

  it('rejects a noncontiguous partial backfill', async () => {
    const agent = await Agent.create({ agentTypeId: typeId })
    const ids = [crypto.randomUUID(), crypto.randomUUID()]
    for (const id of ids) await db.insert(messages).values({ id, agentId: agent.id, role: 'human', content: id })
    await db.update(messages).set({ enqueueOrder: null }).where(eq(messages.agentId, agent.id))
    await db.update(messages).set({ enqueueOrder: -1n }).where(eq(messages.id, ids[0]!))
    await withConnection(async (connection) => {
      await expect(backfillMessageEnqueueOrder(connection)).rejects.toThrow(
        'Existing negative message enqueue orders are not a contiguous partial backfill'
      )
    })
    await db.delete(messages).where(eq(messages.agentId, agent.id))
  })
})
