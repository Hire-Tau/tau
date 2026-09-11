import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq, inArray, like } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, messages, squads } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { cleanupTestRbac, createTestUser, type TestUser } from '../../test-utils'
import { resolveAgentChatSenderUserId } from './agent-human-recipient'

describe('resolveAgentChatSenderUserId', () => {
  let prefix: string
  let agentTypeId: string
  let squad: Squad
  let user: TestUser
  let createdAgentIds: string[]

  beforeEach(async () => {
    prefix = `chatsender-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    agentTypeId = `${prefix}-type`
    createdAgentIds = []
    await AgentType.create({
      id: agentTypeId,
      name: 'CS Test',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'x',
    })
    squad = await Squad.create({ name: `${prefix} Squad`, purpose: 'chat sender test' })
    user = await createTestUser({ prefix })
  })

  afterEach(async () => {
    if (createdAgentIds.length) {
      await db.delete(messages).where(inArray(messages.agentId, createdAgentIds))
      await db.delete(agents).where(inArray(agents.id, createdAgentIds))
    }
    await db.delete(squads).where(like(squads.name, `${prefix}%`))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    await cleanupTestRbac(prefix)
  })

  async function makeAgent(): Promise<Agent> {
    const agent = await Agent.create({ agentTypeId, squadId: squad.id })
    createdAgentIds.push(agent.id)
    return agent
  }

  it('returns the attributed chat sender and ignores later unattributed human rows (inbox/system)', async () => {
    const agent = await makeAgent()
    await agent.recordMessage({
      role: 'human',
      content: 'please build X',
      metadata: { sender: { userId: user.id, name: 'Alice' } },
    })
    // A later human row with no sender (e.g. an inbox delivery) must not shadow the real chat sender.
    await agent.recordMessage({ role: 'human', content: '[inbox] FYI', metadata: { source: 'inbox' } })

    expect(await resolveAgentChatSenderUserId(agent.id)).toBe(user.id)
  })

  it('returns null when the agent has only unattributed human messages', async () => {
    const agent = await makeAgent()
    await agent.recordMessage({ role: 'human', content: '[inbox] something', metadata: { source: 'inbox' } })
    await agent.recordMessage({ role: 'assistant', content: 'working on it' })

    expect(await resolveAgentChatSenderUserId(agent.id)).toBeNull()
  })

  it('returns null for an agent with no messages', async () => {
    const agent = await makeAgent()
    expect(await resolveAgentChatSenderUserId(agent.id)).toBeNull()
  })
})
