import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { db } from '../db'
import { agents } from '../db/schema'
import { Agent } from './Agent'
import { eq } from 'drizzle-orm'

describe('Agent.findByThreadId', () => {
  const testAgentId = crypto.randomUUID()

  beforeAll(async () => {
    // Create a test agent with thread context
    await db.insert(agents).values({
      id: testAgentId,
      agentTypeId: 'concierge',
      squadId: null,
      status: 'idle',
      context: {
        channelInstance: { id: 'test-channel', provider: 'discord' },
        thread: { id: 'thread-123', channelId: 'channel-456', originalMessageId: 'msg-789' },
      },
    })
  })

  afterAll(async () => {
    await db.delete(agents).where(eq(agents.id, testAgentId))
  })

  it('finds agent by discord thread ID', async () => {
    const agent = await Agent.findByThreadId('discord', 'thread-123')
    expect(agent).not.toBeNull()
    expect(agent!.id).toBe(testAgentId)
  })

  it('returns null for unknown thread ID', async () => {
    const agent = await Agent.findByThreadId('discord', 'unknown-thread')
    expect(agent).toBeNull()
  })

  it('returns null for wrong provider', async () => {
    const agent = await Agent.findByThreadId('slack', 'thread-123')
    expect(agent).toBeNull()
  })
})
