import { afterEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, users } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { deleteAgent } from './lifecycle'

const ownerUserId = 'aaaaaaaa-1111-4111-8111-111111111111'
const agentId = 'bbbbbbbb-2222-4222-8222-222222222222'

afterEach(async () => {
  eventEmitter.removeAllListeners()
  await db.delete(agents).where(eq(agents.id, agentId))
  await db.delete(users).where(eq(users.id, ownerUserId))
})

test('agent.deleted retains the private owner context captured before row deletion', async () => {
  await db.insert(users).values({ id: ownerUserId, email: 'lifecycle-delete-owner@example.com' })
  await db.insert(agents).values({ id: agentId, agentTypeId: 'system-manager', ownerUserId })
  const agent = await Agent.find(agentId)
  if (!agent) throw new Error('expected deletion fixture agent')
  const deleted = Promise.withResolvers<{ agentId: string; squadId: string | null; ownerUserId: string | null }>()
  const unsubscribe = eventEmitter.on('agent.deleted', deleted.resolve)

  try {
    await deleteAgent(agent, { reclaim: async () => {} })
    expect(await deleted.promise).toEqual({ agentId, squadId: null, ownerUserId })
    expect(await Agent.find(agentId)).toBeNull()
  } finally {
    unsubscribe()
  }
})
