import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { eq, and } from 'drizzle-orm'
import { db } from '../../db'
import { squads, agents, messages, memoryDocuments, memoryChunks } from '../../db/schema'
import { indexAgentThreads, indexAgentThread, isAgentIndexed, removeAgentThread } from './thread-indexer'
import { ThreadSource } from './sources/ThreadSource'

describe('thread-indexer', () => {
  const testSquadId = crypto.randomUUID()
  let testAgentId: string

  beforeAll(async () => {
    // Create a test squad
    await db.insert(squads).values({
      id: testSquadId,
      name: 'Thread Indexer Test Squad',
      purpose: 'Testing thread indexer',
      status: 'active',
    })

    // Create a test agent
    const [agent] = await db
      .insert(agents)
      .values({
        agentTypeId: 'engineer',
        squadId: testSquadId,
        status: 'idle',
      })
      .returning()

    testAgentId = agent.id
  })

  afterAll(async () => {
    // Clean up in order
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(messages).where(eq(messages.agentId, testAgentId))
    await db.delete(agents).where(eq(agents.squadId, testSquadId))
    await db.delete(squads).where(eq(squads.id, testSquadId))
  })

  beforeEach(async () => {
    // Reset ThreadSource singleton
    ThreadSource._reset()

    // Clean documents and messages before each test
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(messages).where(eq(messages.agentId, testAgentId))
  })

  describe('indexAgentThreads', () => {
    it('indexes all agent threads for a squad', async () => {
      // Create another agent
      const [agent2] = await db
        .insert(agents)
        .values({
          agentTypeId: 'reviewer',
          squadId: testSquadId,
          status: 'idle',
        })
        .returning()

      try {
        // Add messages to both agents
        await db.insert(messages).values([
          { agentId: testAgentId, role: 'human', content: 'Question for agent 1' },
          { agentId: testAgentId, role: 'assistant', content: 'Answer from agent 1' },
        ])

        await db.insert(messages).values([
          { agentId: agent2.id, role: 'human', content: 'Question for agent 2' },
          { agentId: agent2.id, role: 'assistant', content: 'Answer from agent 2' },
        ])

        const stats = await indexAgentThreads(testSquadId)

        expect(stats.total).toBe(2)
        expect(stats.indexed).toBe(2)
        expect(stats.skipped).toBe(0)
        expect(stats.failed).toBe(0)
        expect(stats.errors).toHaveLength(0)

        // Verify both documents exist
        const docs = await db
          .select()
          .from(memoryDocuments)
          .where(and(eq(memoryDocuments.squadId, testSquadId), eq(memoryDocuments.sourceType, 'agent_thread')))

        expect(docs.length).toBe(2)
      } finally {
        // Clean up agent2
        await db.delete(messages).where(eq(messages.agentId, agent2.id))
        await db.delete(agents).where(eq(agents.id, agent2.id))
      }
    })

    it('returns empty stats when no agents in squad', async () => {
      const emptySquadId = crypto.randomUUID()
      await db.insert(squads).values({
        id: emptySquadId,
        name: 'Empty Squad',
        purpose: 'Testing',
        status: 'active',
      })

      try {
        const stats = await indexAgentThreads(emptySquadId)

        expect(stats.total).toBe(0)
        expect(stats.indexed).toBe(0)
        expect(stats.skipped).toBe(0)
        expect(stats.failed).toBe(0)
      } finally {
        await db.delete(squads).where(eq(squads.id, emptySquadId))
      }
    })

    it('handles skipped agents (no messages)', async () => {
      // Agent with no messages
      const stats = await indexAgentThreads(testSquadId)

      expect(stats.total).toBe(1)
      expect(stats.indexed).toBe(0)
      expect(stats.skipped).toBe(1)
    })
  })

  describe('indexAgentThread', () => {
    it('indexes a single agent thread', async () => {
      await db.insert(messages).values([
        { agentId: testAgentId, role: 'human', content: 'Test question' },
        { agentId: testAgentId, role: 'assistant', content: 'Test answer' },
      ])

      const success = await indexAgentThread(testSquadId, testAgentId)

      expect(success).toBe(true)

      // Verify document exists
      const docs = await db.select().from(memoryDocuments).where(eq(memoryDocuments.sourceId, testAgentId))

      expect(docs.length).toBe(1)
    })

    it('returns false for non-existent agent', async () => {
      const success = await indexAgentThread(testSquadId, crypto.randomUUID())

      expect(success).toBe(false)
    })
  })

  describe('isAgentIndexed', () => {
    it('returns false when not indexed', async () => {
      const indexed = await isAgentIndexed(testSquadId, testAgentId)

      expect(indexed).toBe(false)
    })

    it('returns true when indexed', async () => {
      await db.insert(messages).values({
        agentId: testAgentId,
        role: 'human',
        content: 'Test message',
      })

      await indexAgentThread(testSquadId, testAgentId)
      const indexed = await isAgentIndexed(testSquadId, testAgentId)

      expect(indexed).toBe(true)
    })
  })

  describe('removeAgentThread', () => {
    it('removes indexed thread', async () => {
      await db.insert(messages).values({
        agentId: testAgentId,
        role: 'human',
        content: 'Test message',
      })

      await indexAgentThread(testSquadId, testAgentId)
      expect(await isAgentIndexed(testSquadId, testAgentId)).toBe(true)

      await removeAgentThread(testSquadId, testAgentId)
      expect(await isAgentIndexed(testSquadId, testAgentId)).toBe(false)
    })

    it('does not throw when agent not indexed', async () => {
      // Should not throw
      await removeAgentThread(testSquadId, crypto.randomUUID())
    })
  })
})
