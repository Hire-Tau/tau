/**
 * Embedding Worker Tests
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

// Mock OpenAI module BEFORE importing EmbeddingService-dependent modules
const mockEmbeddingsCreate = mock(() =>
  Promise.resolve({
    data: [{ embedding: new Array(1536).fill(0.1) }],
    usage: { total_tokens: 10 },
  })
)

mock.module('openai', () => ({
  default: class OpenAI {
    embeddings = {
      create: mockEmbeddingsCreate,
    }
  },
}))

// Now import modules
import { db } from '../../../db'
import { squads, memoryDocuments, memoryChunks } from '../../../db/schema'
import { eq } from 'drizzle-orm'
import { EmbeddingWorker } from './EmbeddingWorker'
import { computeContentHash } from '../parser'
import { EmbeddingService } from './EmbeddingService'

describe('EmbeddingWorker', () => {
  let testSquadId: string
  let testDocId: string
  let originalApiKey: string | undefined
  let worker: EmbeddingWorker

  beforeEach(async () => {
    // Save original and set API key for tests
    originalApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'test-key'

    // Reset embedding service to pick up new API key
    EmbeddingService._reset()
    EmbeddingWorker._reset()

    // Create a fresh worker for each test (not started)
    worker = EmbeddingWorker.instance()

    // Reset mocks
    mockEmbeddingsCreate.mockClear()
    mockEmbeddingsCreate.mockResolvedValue({
      data: [{ embedding: new Array(1536).fill(0.1) }],
      usage: { total_tokens: 10 },
    })

    // Create test squad
    const [squad] = await db
      .insert(squads)
      .values({
        name: 'Test Squad',
        purpose: 'Testing embeddings',
        metadata: { memory: { enabled: true } },
      })
      .returning()
    testSquadId = squad.id

    // Create test document
    const [doc] = await db
      .insert(memoryDocuments)
      .values({
        squadId: testSquadId,
        sourceType: 'memory_file',
        sourceId: '/memory/test.md',
        title: 'Test Doc',
        path: '/memory/test.md',
        contentHash: 'abc123',
        updatedAt: new Date(),
      })
      .returning()
    testDocId = doc.id
  })

  afterEach(async () => {
    // Restore API key
    if (originalApiKey !== undefined) {
      process.env.OPENAI_API_KEY = originalApiKey
    } else {
      delete process.env.OPENAI_API_KEY
    }
    EmbeddingService._reset()
    EmbeddingWorker._reset()

    // Clean up in correct order (chunks -> docs -> squads)
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(squads).where(eq(squads.id, testSquadId))
  })

  describe('getQueueSize', () => {
    it('returns 0 when no chunks need embeddings', async () => {
      const size = await worker.getQueueSize(testSquadId)
      expect(size).toBe(0)
    })

    it('returns count of chunks without embeddings', async () => {
      // Create chunks without embeddings
      await db.insert(memoryChunks).values([
        {
          squadId: testSquadId,
          documentId: testDocId,
          chunkIndex: 0,
          content: 'Chunk 1 content',
          contentHash: computeContentHash('Chunk 1 content'),
          embedding: null,
        },
        {
          squadId: testSquadId,
          documentId: testDocId,
          chunkIndex: 1,
          content: 'Chunk 2 content',
          contentHash: computeContentHash('Chunk 2 content'),
          embedding: null,
        },
      ])

      const size = await worker.getQueueSize(testSquadId)
      expect(size).toBe(2)
    })

    it('excludes chunks with embeddings', async () => {
      // Create one chunk with embedding, one without
      await db.insert(memoryChunks).values([
        {
          squadId: testSquadId,
          documentId: testDocId,
          chunkIndex: 0,
          content: 'Chunk with embedding',
          contentHash: computeContentHash('Chunk with embedding'),
          embedding: new Array(1536).fill(0.1),
        },
        {
          squadId: testSquadId,
          documentId: testDocId,
          chunkIndex: 1,
          content: 'Chunk without embedding',
          contentHash: computeContentHash('Chunk without embedding'),
          embedding: null,
        },
      ])

      const size = await worker.getQueueSize(testSquadId)
      expect(size).toBe(1)
    })
  })

  describe('processQueue', () => {
    it('returns early when embeddings are disabled', async () => {
      delete process.env.OPENAI_API_KEY
      EmbeddingService._reset()

      const stats = await worker.processQueue()

      expect(stats.processed).toBe(0)
      expect(stats.failed).toBe(0)
      expect(mockEmbeddingsCreate).not.toHaveBeenCalled()

      // Restore for other tests
      process.env.OPENAI_API_KEY = 'test-key'
      EmbeddingService._reset()
    })

    it('returns early when no chunks need embeddings', async () => {
      const stats = await worker.processQueue({ squadId: testSquadId })

      expect(stats.processed).toBe(0)
      expect(mockEmbeddingsCreate).not.toHaveBeenCalled()
    })

    it('processes chunks without embeddings', async () => {
      // Create chunk without embedding
      await db.insert(memoryChunks).values({
        squadId: testSquadId,
        documentId: testDocId,
        chunkIndex: 0,
        content: 'Test content for embedding',
        contentHash: computeContentHash('Test content for embedding'),
        embedding: null,
      })

      // Mock OpenAI response (returns 8 tokens)
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.5) }],
        usage: { total_tokens: 8 },
      })

      const stats = await worker.processQueue({ squadId: testSquadId })

      expect(stats.processed).toBe(1)
      expect(stats.failed).toBe(0)
      expect(stats.totalTokens).toBe(8)

      // Verify embedding was saved
      const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))

      expect(chunks[0].embedding).not.toBeNull()
    })

    it('handles API errors gracefully', async () => {
      // Create chunk
      await db.insert(memoryChunks).values({
        squadId: testSquadId,
        documentId: testDocId,
        chunkIndex: 0,
        content: 'Test content',
        contentHash: computeContentHash('Test content'),
        embedding: null,
      })

      mockEmbeddingsCreate.mockRejectedValueOnce(new Error('API error'))

      const stats = await worker.processQueue({ squadId: testSquadId })

      expect(stats.processed).toBe(0)
      expect(stats.failed).toBe(1)
    })

    it('respects maxChunks option', async () => {
      // Create 5 chunks
      await db.insert(memoryChunks).values(
        Array.from({ length: 5 }, (_, i) => ({
          squadId: testSquadId,
          documentId: testDocId,
          chunkIndex: i,
          content: `Chunk ${i} content`,
          contentHash: computeContentHash(`Chunk ${i} content`),
          embedding: null,
        }))
      )

      // Mock OpenAI to return 2 embeddings (for batch of 2)
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0.1) }, { embedding: new Array(1536).fill(0.1) }],
        usage: { total_tokens: 10 },
      })

      const stats = await worker.processQueue({ squadId: testSquadId, maxChunks: 2 })

      expect(stats.processed).toBe(2)
    })
  })

  describe('clearEmbeddings', () => {
    it('clears embeddings for a squad', async () => {
      // Create chunk with embedding
      await db.insert(memoryChunks).values({
        squadId: testSquadId,
        documentId: testDocId,
        chunkIndex: 0,
        content: 'Test content',
        contentHash: computeContentHash('Test content'),
        embedding: new Array(1536).fill(0.1),
      })

      const cleared = await worker.clearEmbeddings(testSquadId)

      expect(cleared).toBe(1)

      // Verify embedding was cleared
      const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))

      expect(chunks[0].embedding).toBeNull()
    })
  })
})
