import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import { db } from './index'
import { slotClaims, slotNotifications, slotPools, slotWaiters } from './schema'

function checkSql(table: Parameters<typeof getTableConfig>[0], name: string): string {
  const constraint = getTableConfig(table).checks.find((candidate) => candidate.name === name)
  expect(constraint).toBeDefined()
  return new PgDialect().sqlToQuery(constraint!.value).sql
}

test('declares durable slot state and hot-path indexes', () => {
  expect(getTableConfig(slotPools).name).toBe('slot_pools')
  expect(getTableConfig(slotClaims).indexes.map((index) => index.config.name)).toContain(
    'idx_slot_claims_active_owner_unique'
  )
  expect(getTableConfig(slotWaiters).indexes.map((index) => index.config.name)).toEqual(
    expect.arrayContaining(['idx_slot_waiters_queued_owner_unique', 'idx_slot_waiters_fifo'])
  )
  expect(getTableConfig(slotNotifications).indexes.map((index) => index.config.name)).toContain(
    'idx_slot_notifications_due'
  )
})

test('hermetic database reapplies generated slot foreign keys', async () => {
  const constraints = await db.execute<{ name: string }>(sql`
    SELECT conname AS name
    FROM pg_constraint
    WHERE conname IN (
      'slot_pools_squad_id_squads_id_fk',
      'slot_claims_pool_id_slot_pools_id_fk',
      'slot_notifications_pool_id_slot_pools_id_fk',
      'slot_notifications_claim_id_slot_claims_id_fk',
      'slot_notifications_inbox_id_inbox_id_fk',
      'slot_waiters_pool_id_slot_pools_id_fk',
      'slot_waiters_resulting_claim_id_slot_claims_id_fk'
    )
    ORDER BY conname
  `)
  expect(constraints.map(({ name }) => name)).toHaveLength(7)
})

test('constrains slot pool keys, capacity, and timeout bounds', () => {
  expect(checkSql(slotPools, 'slot_pools_key_format')).toContain('^[a-z][a-z0-9._-]{0,63}$')
  expect(checkSql(slotPools, 'slot_pools_capacity_positive')).toContain('capacity')
  const timeout = checkSql(slotPools, 'slot_pools_claim_timeout_bounds')
  expect(timeout).toContain('60000')
  expect(timeout).toContain('86400000')
})

test('keeps one active claim and one queued waiter per owner and pool', () => {
  const claimIndex = getTableConfig(slotClaims).indexes.find(
    (index) => index.config.name === 'idx_slot_claims_active_owner_unique'
  )
  const waiterIndex = getTableConfig(slotWaiters).indexes.find(
    (index) => index.config.name === 'idx_slot_waiters_queued_owner_unique'
  )

  expect(claimIndex?.config.unique).toBe(true)
  expect(claimIndex?.config.columns.map((column) => (column as { name: string }).name)).toEqual([
    'pool_id',
    'owner_agent_id',
  ])
  expect(claimIndex?.config.where).toBeDefined()
  expect(waiterIndex?.config.unique).toBe(true)
  expect(waiterIndex?.config.columns.map((column) => (column as { name: string }).name)).toEqual([
    'pool_id',
    'owner_agent_id',
  ])
  expect(waiterIndex?.config.where).toBeDefined()
})
