import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { agents, assistantConversationAgents, assistantConversations, db, squads } from '../db'
import { Agent } from '../entities/Agent'
import { Squad } from '../entities/Squad'
import { cleanupTestRbac, createTestUser } from '../test-utils'
import { findOwningConversation, resolveOwnedAgent } from './assistant-agents'

const prefix = `assistant-agents-${randomUUID()}`
const conversationIds: string[] = []
const squadIds: string[] = []

async function conversation() {
  const owner = await createTestUser({ prefix })
  const [row] = await db.insert(assistantConversations).values({ ownerUserId: owner.id }).returning()
  conversationIds.push(row!.id)
  return row!
}

async function agentIdsFor(conversationId: string) {
  return db
    .select({ squadId: assistantConversationAgents.squadId, agentId: assistantConversationAgents.agentId })
    .from(assistantConversationAgents)
    .where(eq(assistantConversationAgents.conversationId, conversationId))
}

afterEach(async () => {
  const rows = conversationIds.length
    ? await db
        .select({ agentId: assistantConversationAgents.agentId })
        .from(assistantConversationAgents)
        .where(inArray(assistantConversationAgents.conversationId, conversationIds))
    : []
  if (conversationIds.length)
    await db.delete(assistantConversations).where(inArray(assistantConversations.id, conversationIds.splice(0)))
  if (rows.length) await db.delete(agents).where(inArray(agents.id, rows.map((row) => row.agentId)))
  if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds.splice(0)))
  await cleanupTestRbac(prefix)
})

test('the general helper is a system-manager owned by the conversation owner, created once', async () => {
  const row = await conversation()
  const first = await db.transaction((tx) => resolveOwnedAgent(tx, row, { squadId: null }))
  const second = await db.transaction((tx) => resolveOwnedAgent(tx, row, { squadId: null }))
  expect(second.id).toBe(first.id)
  expect(first.agentTypeId).toBe('system-manager')
  expect(first.ownerUserId).toBe(row.ownerUserId)
  expect(await agentIdsFor(row.id)).toEqual([{ squadId: null, agentId: first.id }])
  expect(await findOwningConversation(first.id)).toMatchObject({ id: row.id })
})

test('a squad target creates one consultant per squad with the consultant scope', async () => {
  const row = await conversation()
  const squad = await Squad.create({ name: `${prefix}-squad`, purpose: 'test' })
  squadIds.push(squad.id)
  const consultant = await db.transaction((tx) => resolveOwnedAgent(tx, row, { squadId: squad.id }))
  const again = await db.transaction((tx) => resolveOwnedAgent(tx, row, { squadId: squad.id }))
  expect(again.id).toBe(consultant.id)
  expect(consultant.agentTypeId).toBe('consultant')
  expect(consultant.squadId).toBe(squad.id)
  expect(consultant.persist).toBe(false)
  expect(consultant.ownerUserId).toBeNull()
  expect(consultant.metadata?.name).toBe('Assistant task')
  expect(consultant.context).toMatchObject({ scope: { type: 'consultant', id: squad.id } })
  // The general helper and the consultant coexist; the consultant never owns the page editor.
  const general = await db.transaction((tx) => resolveOwnedAgent(tx, row, { squadId: null }))
  expect(general.id).not.toBe(consultant.id)
  expect((await agentIdsFor(row.id)).length).toBe(2)
  expect(await findOwningConversation(consultant.id)).toBeUndefined()
})

test('a terminated owned agent is replaced and the old one is left in place', async () => {
  const row = await conversation()
  const squad = await Squad.create({ name: `${prefix}-squad-2`, purpose: 'test' })
  squadIds.push(squad.id)
  const stale = await db.transaction((tx) => resolveOwnedAgent(tx, row, { squadId: squad.id }))
  await Agent.update(stale.id, { status: 'terminated' })
  const fresh = await db.transaction((tx) => resolveOwnedAgent(tx, row, { squadId: squad.id }))
  expect(fresh.id).not.toBe(stale.id)
  expect(await agentIdsFor(row.id)).toEqual([{ squadId: squad.id, agentId: fresh.id }])
  expect(await Agent.find(stale.id)).not.toBeNull()
  await db.delete(agents).where(eq(agents.id, stale.id))
})
