import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import { memoryChunks, memoryDocuments, memoryLinks, squads } from '../../../db/schema'
import { IndexedDocumentWriter } from './IndexedDocumentWriter'

describe('IndexedDocumentWriter', () => {
  const squadId = crypto.randomUUID()

  beforeEach(async () => {
    await db.delete(memoryLinks).where(eq(memoryLinks.squadId, squadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, squadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, squadId))
    await db
      .insert(squads)
      .values({ id: squadId, name: 'Writer squad', purpose: 'Testing writer', status: 'active' })
      .onConflictDoNothing()
  })

  afterAll(async () => {
    await db.delete(memoryLinks).where(eq(memoryLinks.squadId, squadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, squadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it('writes a document and preserves unchanged chunks on repeat writes', async () => {
    const writer = IndexedDocumentWriter.instance()

    const first = await writer.writeDocument({
      squadId,
      sourceType: 'test_source',
      sourceId: 'doc-1',
      adapterDefaultSensitivity: 'internal',
      fetched: {
        content: '# Hello\n\nA body.',
        frontmatter: { title: 'Frontmatter title' },
        path: '/memory/doc-1.md',
      },
    })

    expect(first.success).toBe(true)
    expect(first.chunksCreated).toBeGreaterThan(0)

    const second = await writer.writeDocument({
      squadId,
      sourceType: 'test_source',
      sourceId: 'doc-1',
      adapterDefaultSensitivity: 'internal',
      fetched: {
        content: '# Hello\n\nA body.',
        frontmatter: { title: 'Frontmatter title' },
        path: '/memory/doc-1.md',
      },
    })

    expect(second.success).toBe(true)
    expect(second.skipped).toBe(true)
    expect(second.documentId).toBe(first.documentId)

    const docs = await db.select().from(memoryDocuments).where(eq(memoryDocuments.squadId, squadId))
    const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.squadId, squadId))
    expect(docs).toHaveLength(1)
    expect(chunks.length).toBe(first.chunksCreated)
    expect(docs[0].title).toBe('Frontmatter title')
    expect(docs[0].sensitivity).toBe('internal')
  })
})
