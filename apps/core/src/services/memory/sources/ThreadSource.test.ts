import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../db'
import { squads, agents, messages, memoryDocuments, memoryChunks, workStreams } from '../../../db/schema'
import { ThreadSource } from './ThreadSource'

const source = ThreadSource.instance()

describe('ThreadSource', () => {
  const testSquadId = crypto.randomUUID()
  let testAgentId: string

  beforeAll(async () => {
    // Create a test squad
    await db.insert(squads).values({
      id: testSquadId,
      name: 'Thread Source Test Squad',
      purpose: 'Testing thread source adapter',
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
    await db.delete(workStreams).where(eq(workStreams.squadId, testSquadId))
    await db.delete(agents).where(eq(agents.squadId, testSquadId))
    await db.delete(squads).where(eq(squads.id, testSquadId))
  })

  beforeEach(async () => {
    // Clean documents, messages, and work streams before each test
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(messages).where(eq(messages.agentId, testAgentId))
    await db.delete(workStreams).where(eq(workStreams.squadId, testSquadId))
  })

  describe('buildContent', () => {
    it('formats messages into markdown', () => {
      const threadMessages = [
        {
          id: '1',
          role: 'human' as const,
          content: 'Help me understand the authentication flow.',
          createdAt: new Date(),
        },
        {
          id: '2',
          role: 'assistant' as const,
          content:
            'The authentication flow works as follows:\n\n1. User enters credentials\n2. Server validates and returns JWT\n3. Client stores JWT for subsequent requests',
          createdAt: new Date(),
        },
        { id: '3', role: 'human' as const, content: 'What about refresh tokens?', createdAt: new Date() },
        {
          id: '4',
          role: 'assistant' as const,
          content: 'Refresh tokens allow obtaining new JWTs without re-authentication.',
          createdAt: new Date(),
        },
      ]

      const content = source.buildContent(threadMessages)

      // Should contain all messages
      expect(content).toContain('authentication flow')
      expect(content).toContain('JWT')
      expect(content).toContain('refresh tokens')

      // Should have role markers
      expect(content).toContain('Human:')
      expect(content).toContain('Assistant:')
    })

    it('handles empty message list', () => {
      const content = source.buildContent([])
      expect(content).toBe('')
    })
  })

  describe('fetch', () => {
    it('orders and timestamps delivered transcript rows by effective visible time', async () => {
      const consumedAt = '2026-08-10T10:30:00.123456Z'
      const humanId = '00000000-0000-4000-8000-000000000030'
      await db.insert(messages).values([
        {
          id: '00000000-0000-4000-8000-000000000015',
          agentId: testAgentId,
          role: 'human',
          content: 'PENDING_BEFORE',
          pending: true,
          createdAt: new Date('2026-08-10T10:15:00.000Z'),
        },
        {
          id: '00000000-0000-4000-8000-000000000020',
          agentId: testAgentId,
          role: 'assistant',
          content: 'SYSTEM_AT_20',
          metadata: { isSystem: true, consumedAt: '2026-08-10T12:00:00.000Z' },
          createdAt: new Date('2026-08-10T10:20:00.000Z'),
        },
        {
          id: '00000000-0000-4000-8000-000000000025',
          agentId: testAgentId,
          role: 'assistant',
          content: 'TOOL_AT_25',
          metadata: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-block',
                toolCall: {
                  toolCallId: 'call-1',
                  toolName: 'read',
                  args: '{}',
                  result: 'ok',
                  isError: false,
                },
              },
            ],
          },
          createdAt: new Date('2026-08-10T10:25:00.000Z'),
        },
        {
          id: humanId,
          agentId: testAgentId,
          role: 'human',
          content: 'CONSUMED_AT_30',
          pending: false,
          metadata: { source: 'inbox', deliveryMode: 'follow-up', consumedAt },
          createdAt: new Date('2026-08-01T10:00:00.000Z'),
        },
        {
          id: '00000000-0000-4000-8000-000000000035',
          agentId: testAgentId,
          role: 'human',
          content: 'PENDING_AFTER',
          pending: true,
          createdAt: new Date('2026-08-10T10:35:00.000Z'),
        },
        {
          id: '00000000-0000-4000-8000-000000000040',
          agentId: testAgentId,
          role: 'assistant',
          content: 'ASSISTANT_AT_40',
          createdAt: new Date('2026-08-10T10:40:00.000Z'),
        },
        // Insert the lexically higher equal-time ID first to prove the explicit tie-break.
        {
          id: 'eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee',
          agentId: testAgentId,
          role: 'assistant',
          content: 'EQUAL_HIGH',
          createdAt: new Date('2026-08-10T10:45:00.000Z'),
        },
        {
          id: '00000000-0000-4000-8000-000000000045',
          agentId: testAgentId,
          role: 'assistant',
          content: 'EQUAL_LOW',
          createdAt: new Date('2026-08-10T10:45:00.000Z'),
        },
      ])

      const [human] = await db.select().from(messages).where(eq(messages.id, humanId))
      expect(human.createdAt.toISOString()).toBe('2026-08-01T10:00:00.000Z')
      expect((human.metadata as { consumedAt?: string } | null)?.consumedAt).toBe(consumedAt)
      expect(human.createdAt.getTime()).not.toBe(new Date(consumedAt).getTime())

      const fetched = await source.fetch(testSquadId, testAgentId)
      expect(fetched).not.toBeNull()
      const content = fetched!.content
      const markers = ['SYSTEM_AT_20', 'TOOL_AT_25', 'CONSUMED_AT_30', 'ASSISTANT_AT_40', 'EQUAL_LOW', 'EQUAL_HIGH']
      const positions = markers.map((marker) => content.indexOf(marker))
      expect(positions[0]).toBeGreaterThan(-1)
      for (let index = 1; index < positions.length; index++) {
        expect(positions[index]).toBeGreaterThan(positions[index - 1]!)
      }
      expect(content).not.toContain('PENDING_BEFORE')
      expect(content).not.toContain('PENDING_AFTER')
      expect(fetched!.frontmatter!.messageCount).toBe(6)

      const line = content.split('\n').findIndex((value) => value.includes('CONSUMED_AT_30')) + 1
      const metadata = fetched!.chunkMetadataForChunk?.({
        index: 0,
        content: 'CONSUMED_AT_30',
        startLine: line,
        endLine: line,
        metadata: {},
      })
      expect(metadata?.event).toEqual({
        ts: '2026-08-10T10:30:00.123Z',
        actor: 'human',
        externalId: humanId,
      })
    })
  })

  describe('index', () => {
    it('indexes agent messages as memory document', async () => {
      // Add test messages
      await db.insert(messages).values([
        { agentId: testAgentId, role: 'human', content: 'What is the best approach for error handling?' },
        {
          agentId: testAgentId,
          role: 'assistant',
          content: 'Use try-catch blocks with proper error types and logging.',
        },
      ])

      const result = await source.index(testSquadId, testAgentId)

      expect(result.success).toBe(true)
      expect(result.documentId).toBeDefined()
      expect(result.chunksCreated).toBeGreaterThan(0)

      // Verify document exists
      const exists = await source.exists(testSquadId, testAgentId)
      expect(exists).toBe(true)

      // Verify document content and metadata
      const docs = await db
        .select()
        .from(memoryDocuments)
        .where(
          and(
            eq(memoryDocuments.squadId, testSquadId),
            eq(memoryDocuments.sourceType, 'agent_thread'),
            eq(memoryDocuments.sourceId, testAgentId)
          )
        )
      const doc = docs[0]
      expect(doc).toBeDefined()
      expect(doc.sourceType).toBe('agent_thread')
      expect(doc.sourceId).toBe(testAgentId)

      // Check frontmatter includes all required metadata
      const frontmatter = doc.frontmatter as Record<string, unknown>
      expect(frontmatter.agentId).toBe(testAgentId)
      expect(frontmatter.agentType).toBe('engineer')
      expect(frontmatter.messageCount).toBe(2)
      expect(frontmatter.kind).toBe('thread')

      // Verify chunks contain message content
      const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, doc.id))
      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.some((c) => c.content.includes('error handling'))).toBe(true)

      // Verify chunk metadata
      const chunkMeta = chunks[0].metadata as Record<string, unknown>
      expect(chunkMeta.sourceType).toBe('agent_thread')
      expect(chunkMeta.agentId).toBe(testAgentId)
      expect(chunkMeta.agentType).toBe('engineer')
    })

    it('emits event-shaped metadata on chunks for message contributions', async () => {
      const firstTs = new Date('2026-05-15T10:00:00.000Z')
      const secondTs = new Date('2026-05-15T10:01:00.000Z')
      await db.insert(messages).values([
        { agentId: testAgentId, role: 'human', content: 'Question with event metadata', createdAt: firstTs },
        { agentId: testAgentId, role: 'assistant', content: 'Answer with event metadata', createdAt: secondTs },
      ])

      const result = await source.index(testSquadId, testAgentId)
      expect(result.success).toBe(true)

      const [doc] = await db.select().from(memoryDocuments).where(eq(memoryDocuments.sourceId, testAgentId))
      const chunks = await db
        .select()
        .from(memoryChunks)
        .where(eq(memoryChunks.documentId, doc.id))
        .orderBy(memoryChunks.chunkIndex)

      expect(chunks.length).toBeGreaterThan(0)
      for (const chunk of chunks) {
        const metadata = chunk.metadata as Record<string, unknown>
        expect(metadata.sourceType).toBe('agent_thread')
        expect(metadata.event).toEqual({
          ts: expect.stringMatching(/^2026-05-15T10:0[01]:00\.000Z$/),
          actor: expect.stringMatching(/^(human|assistant)$/),
          externalId: expect.any(String),
        })
        expect(metadata.parent).toEqual({ agentId: testAgentId })
      }
    })

    it('includes workStreamIds in metadata when agent has work streams', async () => {
      // Create a work stream with the agent assigned
      const [ws] = await db
        .insert(workStreams)
        .values({
          squadId: testSquadId,
          title: 'Test Work Stream',
          agentIds: [testAgentId],
        })
        .returning()

      await db.insert(messages).values([
        { agentId: testAgentId, role: 'human', content: 'Test message' },
        { agentId: testAgentId, role: 'assistant', content: 'Test response' },
      ])

      const result = await source.index(testSquadId, testAgentId)
      expect(result.success).toBe(true)

      // Verify workStreamIds in document frontmatter
      const docs = await db.select().from(memoryDocuments).where(eq(memoryDocuments.sourceId, testAgentId))
      const frontmatter = docs[0].frontmatter as Record<string, unknown>
      expect(frontmatter.workStreamIds).toEqual([ws.id])

      // Verify workStreamIds in chunk metadata
      const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, docs[0].id))
      const chunkMeta = chunks[0].metadata as Record<string, unknown>
      expect(chunkMeta.workStreamIds).toEqual([ws.id])
    })

    it('preserves unchanged chunks on re-index', async () => {
      // Initial messages
      await db.insert(messages).values([
        { agentId: testAgentId, role: 'human', content: 'Initial question about authentication' },
        { agentId: testAgentId, role: 'assistant', content: 'Initial answer about JWT tokens' },
      ])

      const result1 = await source.index(testSquadId, testAgentId)
      expect(result1.success).toBe(true)
      expect(result1.chunksCreated).toBeGreaterThan(0)

      // Get initial chunk IDs and hashes
      const docs = await db.select().from(memoryDocuments).where(eq(memoryDocuments.sourceId, testAgentId))
      const initialChunks = await db
        .select()
        .from(memoryChunks)
        .where(eq(memoryChunks.documentId, docs[0].id))
        .orderBy(memoryChunks.chunkIndex)

      // Add more messages
      await db.insert(messages).values([
        { agentId: testAgentId, role: 'human', content: 'Follow up question about refresh tokens' },
        { agentId: testAgentId, role: 'assistant', content: 'Follow up answer about token rotation' },
      ])

      const result2 = await source.index(testSquadId, testAgentId)
      expect(result2.success).toBe(true)

      // Should have preserved some chunks
      expect(result2.chunksPreserved).toBeGreaterThan(0)

      // The initial chunks should still exist with same IDs
      const finalChunks = await db
        .select()
        .from(memoryChunks)
        .where(eq(memoryChunks.documentId, docs[0].id))
        .orderBy(memoryChunks.chunkIndex)

      // Verify some initial chunks were preserved (have same content hash)
      const initialHashes = new Set(initialChunks.map((c) => c.contentHash))
      const preservedCount = finalChunks.filter((c) => initialHashes.has(c.contentHash)).length
      expect(preservedCount).toBeGreaterThan(0)
    })

    it('skips indexing when no messages', async () => {
      // No messages for this agent
      const result = await source.index(testSquadId, testAgentId)

      expect(result.success).toBe(true)
      expect(result.chunksCreated).toBe(0)
      expect(result.skipped).toBe(true)
    })

    it('skips indexing when content unchanged', async () => {
      await db.insert(messages).values([
        { agentId: testAgentId, role: 'human', content: 'Test message' },
        { agentId: testAgentId, role: 'assistant', content: 'Test response' },
      ])

      // First index
      await source.index(testSquadId, testAgentId)

      // Second index should skip (no changes)
      const result = await source.index(testSquadId, testAgentId)

      expect(result.success).toBe(true)
      expect(result.skipped).toBe(true)
      expect(result.chunksCreated).toBe(0)
    })

    it('backfills event metadata when reindexing unchanged legacy chunks', async () => {
      await db.insert(messages).values([
        {
          agentId: testAgentId,
          role: 'human',
          content: 'Legacy question',
          createdAt: new Date('2026-05-15T11:00:00.000Z'),
        },
        {
          agentId: testAgentId,
          role: 'assistant',
          content: 'Legacy answer',
          createdAt: new Date('2026-05-15T11:01:00.000Z'),
        },
      ])

      const first = await source.index(testSquadId, testAgentId)
      expect(first.success).toBe(true)

      const [doc] = await db.select().from(memoryDocuments).where(eq(memoryDocuments.sourceId, testAgentId))
      const legacyChunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, doc.id))
      expect(legacyChunks.length).toBeGreaterThan(0)
      for (const chunk of legacyChunks) {
        const metadata = chunk.metadata as Record<string, unknown>
        const { event: _event, parent: _parent, ...legacyMetadata } = metadata
        await db.update(memoryChunks).set({ metadata: legacyMetadata }).where(eq(memoryChunks.id, chunk.id))
      }

      const reindexed = await source.index(testSquadId, testAgentId)
      expect(reindexed.success).toBe(true)
      expect(reindexed.skipped).toBe(true)

      const backfilledChunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, doc.id))
      for (const chunk of backfilledChunks) {
        const metadata = chunk.metadata as Record<string, unknown>
        expect(metadata.event).toEqual({
          ts: expect.stringMatching(/^2026-05-15T11:0[01]:00\.000Z$/),
          actor: expect.stringMatching(/^(human|assistant)$/),
          externalId: expect.any(String),
        })
        expect(metadata.parent).toEqual({ agentId: testAgentId })
      }
    })

    it('returns error when agent not found', async () => {
      const result = await source.index(testSquadId, crypto.randomUUID())

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('preserves message order (chronological)', async () => {
      // Add messages with specific order
      await db.insert(messages).values({
        agentId: testAgentId,
        role: 'human',
        content: 'FIRST_MESSAGE',
      })

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10))

      await db.insert(messages).values({
        agentId: testAgentId,
        role: 'assistant',
        content: 'SECOND_MESSAGE',
      })

      await new Promise((resolve) => setTimeout(resolve, 10))

      await db.insert(messages).values({
        agentId: testAgentId,
        role: 'human',
        content: 'THIRD_MESSAGE',
      })

      await source.index(testSquadId, testAgentId)

      const docs = await db.select().from(memoryDocuments).where(eq(memoryDocuments.sourceId, testAgentId))
      const doc = docs[0]
      const chunks = await db
        .select()
        .from(memoryChunks)
        .where(eq(memoryChunks.documentId, doc.id))
        .orderBy(memoryChunks.chunkIndex)

      // Join all chunk content
      const fullContent = chunks.map((c) => c.content).join('\n')

      // Verify order
      const firstIdx = fullContent.indexOf('FIRST_MESSAGE')
      const secondIdx = fullContent.indexOf('SECOND_MESSAGE')
      const thirdIdx = fullContent.indexOf('THIRD_MESSAGE')

      expect(firstIdx).toBeLessThan(secondIdx)
      expect(secondIdx).toBeLessThan(thirdIdx)
    })
  })

  describe('indexAll', () => {
    it('indexes all agent threads in a squad', async () => {
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

        const results = await source.indexAll(testSquadId)

        expect(results.length).toBeGreaterThanOrEqual(2)
        expect(results.filter((r) => r.success && !r.skipped).length).toBe(2)

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
  })

  describe('exists', () => {
    it('returns false when no document exists', async () => {
      const exists = await source.exists(testSquadId, testAgentId)
      expect(exists).toBe(false)
    })

    it('returns true after indexing', async () => {
      await db.insert(messages).values({
        agentId: testAgentId,
        role: 'human',
        content: 'Test message',
      })

      await source.index(testSquadId, testAgentId)
      const exists = await source.exists(testSquadId, testAgentId)
      expect(exists).toBe(true)
    })
  })

  describe('remove', () => {
    it('removes document and chunks', async () => {
      await db.insert(messages).values({
        agentId: testAgentId,
        role: 'human',
        content: 'Test message for removal',
      })

      await source.index(testSquadId, testAgentId)
      expect(await source.exists(testSquadId, testAgentId)).toBe(true)

      await source.remove(testSquadId, testAgentId)
      expect(await source.exists(testSquadId, testAgentId)).toBe(false)

      // Verify no orphaned chunks
      const docs = await db.select().from(memoryDocuments).where(eq(memoryDocuments.sourceId, testAgentId))
      expect(docs.length).toBe(0)
    })

    it('is a no-op when document does not exist', async () => {
      // Should not throw
      await source.remove(testSquadId, testAgentId)
    })
  })

  describe('sensitivity', () => {
    it('defaults indexed threads and chunks to internal sensitivity', async () => {
      await db.insert(messages).values({ agentId: testAgentId, role: 'human', content: 'Remember this thread.' })
      const indexed = await source.index(testSquadId, testAgentId)
      expect(indexed.success).toBe(true)

      const [doc] = await db
        .select()
        .from(memoryDocuments)
        .where(
          and(
            eq(memoryDocuments.squadId, testSquadId),
            eq(memoryDocuments.sourceType, 'agent_thread'),
            eq(memoryDocuments.sourceId, testAgentId)
          )
        )
      expect(doc.sensitivity).toBe('internal')
      const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, doc.id))
      expect(chunks.length).toBeGreaterThan(0)
      for (const chunk of chunks) expect(chunk.sensitivity).toBe('internal')
    })
  })
})
