import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { agents, inbox, db, slotClaims, slotNotifications, slotPools, slotWaiters, squads } from '../db'
import { authzSentinel, identityMiddleware } from '../middleware'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../test-utils'
import { agentsRouter } from './agents'
import {
  claimSlot,
  registerPool,
  releaseSlot,
  setSlotPromptDrainEnabledForTest,
  unsubscribeSlot,
} from '../services/slots/store'
import { reconcileSlotsOnce } from '../services/slots/reconciliation'
import { eventEmitter } from '../lib/infra/event-emitter'

const prefix = `agent-slot-waits-${crypto.randomUUID()}`
const app = new Hono()
app.use('*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/agents', agentsRouter)
let reader: TestUser
let agentOnly: TestUser
let slotOnly: TestUser
let foreign: TestUser
let squadId: string
let agentId: string
let holderId: string
let poolIds: string[] = []
let unsubscribe: (() => void) | undefined

beforeAll(async () => {
  ;[reader, agentOnly, slotOnly, foreign] = await Promise.all(
    Array.from({ length: 4 }, () => createTestUser({ prefix }))
  )
})
afterAll(async () => cleanupTestRbac(prefix))
afterEach(async () => {
  unsubscribe?.()
  unsubscribe = undefined
  setSlotPromptDrainEnabledForTest(true)
  if (poolIds.length) {
    await db.delete(slotNotifications).where(inArray(slotNotifications.poolId, poolIds))
    await db.delete(slotWaiters).where(inArray(slotWaiters.poolId, poolIds))
    await db.delete(slotClaims).where(inArray(slotClaims.poolId, poolIds))
    await db.delete(slotPools).where(inArray(slotPools.id, poolIds))
  }
  poolIds = []
  if (squadId) {
    await db.delete(inbox).where(inArray(inbox.recipientId, [agentId, holderId]))
    await db.delete(agents).where(eq(agents.id, agentId))
    await db.delete(agents).where(eq(agents.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
})

async function fixture() {
  setSlotPromptDrainEnabledForTest(false)
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'Test' }).returning()
  squadId = squad.id
  const rows = await db
    .insert(agents)
    .values([
      { agentTypeId: prefix, squadId },
      { agentTypeId: prefix, squadId },
    ])
    .returning()
  ;[agentId, holderId] = rows.map((row) => row.id)
  for (const [user, permissions] of [
    [reader, ['agents:read', 'slots:use']],
    [agentOnly, ['agents:read']],
    [slotOnly, ['slots:write']],
  ] as const) {
    const role = await createTestRole({ prefix, permissions: [...permissions] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })
  }
}
async function pool(key: string) {
  const result = await registerPool({ squadId, key, createdBy: 'test' })
  poolIds.push(result.id)
  const held = await claimSlot(squadId, key, holderId)
  const wait = await claimSlot(squadId, key, agentId)
  if (held.outcome !== 'granted' || wait.outcome !== 'queued') throw new Error('Expected contested pool')
  return { pool: result, held, wait }
}
const get = (user?: TestUser, id = agentId) =>
  app.request(`/api/agents/${id}/slot-waits`, { headers: user ? authHeaders(user.token) : {} })

describe('agent queued slot projection', () => {
  test('returns only the viewed agent queued pool keys, not holders or other agents', async () => {
    await fixture()
    const second = await pool('second')
    await pool('first')
    const response = await get(reader)
    expect(response.status).toBe(200)
    const waits = await response.json()
    expect(waits.map((wait: { poolKey: string }) => wait.poolKey)).toEqual(['first', 'second'])
    expect(Object.keys(waits[0]).sort()).toEqual(['poolKey', 'queuedAt', 'waiterId'])
    expect(await (await get(reader, holderId)).json()).toEqual([])
    await releaseSlot(squadId, 'second', holderId, second.held.claim.id)
    expect((await (await get(reader)).json()).map((wait: { poolKey: string }) => wait.poolKey)).toEqual(['first'])
  })

  test('requires both agent visibility and slot permission in the same squad', async () => {
    await fixture()
    await pool('private-pool')
    for (const user of [undefined, foreign, agentOnly, slotOnly]) {
      const response = await get(user)
      expect([401, 403]).toContain(response.status)
      expect(await response.text()).not.toContain('private-pool')
    }
    expect([403, 404]).toContain((await get(reader, crypto.randomUUID())).status)
  })

  test('does not expose another user owned agent even with squad permissions', async () => {
    await fixture()
    await pool('private-pool')
    await db.update(agents).set({ ownerUserId: foreign.id, squadId: null }).where(eq(agents.id, agentId))
    const response = await get(reader)
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('private-pool')
  })

  for (const invalid of ['unsubscribed', 'unregistered', 'archived', 'dormant', 'foreign owner'] as const) {
    test(`omits ${invalid} waiters even before repair`, async () => {
      await fixture()
      const queued = await pool('capacity')
      if (invalid === 'unsubscribed') await unsubscribeSlot(squadId, 'capacity', agentId, queued.wait.waiter.id)
      if (invalid === 'unregistered')
        await db.update(slotPools).set({ unregisteredAt: new Date() }).where(eq(slotPools.id, queued.pool.id))
      if (invalid === 'archived') await db.update(squads).set({ archivedAt: new Date() }).where(eq(squads.id, squadId))
      if (invalid === 'dormant') await db.update(agents).set({ status: 'dormant' }).where(eq(agents.id, agentId))
      if (invalid === 'foreign owner')
        await db
          .update(slotWaiters)
          .set({ ownerAgentId: crypto.randomUUID() })
          .where(eq(slotWaiters.id, queued.wait.waiter.id))
      expect(await (await get(reader)).json()).toEqual([])
    })
  }

  test('emits content-free squad invalidations after enqueue, unsubscribe and promotion commit', async () => {
    await fixture()
    const events: Array<{ squadId: string }> = []
    unsubscribe = eventEmitter.on('slots.updated', (data) => {
      if (data.squadId === squadId) events.push(data)
    })
    const queued = await pool('capacity')
    expect(events.length).toBeGreaterThan(0)
    expect(await (await get(reader)).json()).toHaveLength(1)
    events.length = 0
    await unsubscribeSlot(squadId, 'capacity', agentId, queued.wait.waiter.id)
    expect(events).toEqual([{ squadId }])
    expect(await (await get(reader)).json()).toEqual([])
    await claimSlot(squadId, 'capacity', agentId)
    events.length = 0
    await releaseSlot(squadId, 'capacity', holderId, queued.held.claim.id)
    expect(events).toEqual([{ squadId }])
    expect(await (await get(reader)).json()).toEqual([])
  })

  test('reconciliation expiry promotes the waiter and invalidates the queued projection', async () => {
    await fixture()
    const queued = await pool('capacity')
    const events: Array<{ squadId: string }> = []
    unsubscribe = eventEmitter.on('slots.updated', (data) => {
      if (data.squadId === squadId) events.push(data)
    })
    await db
      .update(slotClaims)
      .set({ expiresAt: new Date(0) })
      .where(eq(slotClaims.id, queued.held.claim.id))
    await reconcileSlotsOnce()
    expect(events).toEqual([{ squadId }])
    expect(await (await get(reader)).json()).toEqual([])
  })
})
