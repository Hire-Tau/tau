import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import { squads, memoryDocuments, memoryChunks, memoryLinks } from '../../../db/schema'
import { IndexingService } from './IndexingService'

const indexingService = IndexingService.instance()

describe('IndexingService', () => {
  const testSquadId = crypto.randomUUID()

  beforeAll(async () => {
    // Create a test squad for foreign key constraints
    await db.insert(squads).values({
      id: testSquadId,
      name: 'Memory Indexer Test Squad',
      purpose: 'Testing memory indexer',
      status: 'active',
    })
  })

  afterAll(async () => {
    // Clean up in reverse order of dependencies
    await db.delete(memoryLinks).where(eq(memoryLinks.squadId, testSquadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(squads).where(eq(squads.id, testSquadId))
  })

  beforeEach(async () => {
    // Clean documents before each test
    await db.delete(memoryLinks).where(eq(memoryLinks.squadId, testSquadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
  })

  describe('indexFile', () => {
    it('indexes a markdown file with frontmatter', async () => {
      const content = `---
title: Test Decision
kind: decision
tags: [auth, backend]
importance: 0.8
---

# JWT Auth Decision

We decided to use JWT tokens for authentication.

## Rationale

JWTs are stateless and work well with our architecture.`

      const result = await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/decisions/auth.md',
        content,
      })

      expect(result.success).toBe(true)
      expect(result.documentId).toBeDefined()
      expect(result.chunksCreated).toBeGreaterThan(0)

      // Verify document was created
      const doc = await indexingService.getDocumentByPath(testSquadId, '/memory/decisions/auth.md')
      expect(doc).toBeDefined()
      expect(doc!.title).toBe('Test Decision')
      expect(doc!.frontmatter).toEqual({
        title: 'Test Decision',
        kind: 'decision',
        tags: ['auth', 'backend'],
        importance: 0.8,
      })

      // Verify chunks were created
      const chunks = await db
        .select()
        .from(memoryChunks)
        .where(eq(memoryChunks.documentId, doc!.id))
        .orderBy(memoryChunks.chunkIndex)

      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks[0].content).toContain('JWT Auth Decision')
    })

    it('extracts and stores wikilinks', async () => {
      const content = `---
title: Overview
---

# Overview

See [[decisions/auth]] for auth details.
Also check [[patterns/react-query|React Query patterns]].
Related: [[decisions/auth#Rationale]].`

      await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/overview.md',
        content,
      })

      const doc = await indexingService.getDocumentByPath(testSquadId, '/memory/overview.md')
      expect(doc).toBeDefined()

      const links = await db.select().from(memoryLinks).where(eq(memoryLinks.sourceDocumentId, doc!.id))

      expect(links.length).toBe(3)

      const linkTargets = links.map((l) => l.targetRaw)
      expect(linkTargets).toContain('[[decisions/auth]]')
      expect(linkTargets).toContain('[[patterns/react-query|React Query patterns]]')
      expect(linkTargets).toContain('[[decisions/auth#Rationale]]')

      // Check heading extraction
      const headingLink = links.find((l) => l.targetRaw.includes('#Rationale'))
      expect(headingLink?.targetHeading).toBe('Rationale')
    })

    it('updates existing document on re-index', async () => {
      const initialContent = `---
title: Initial Title
---

# Initial Content`

      await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/test.md',
        content: initialContent,
      })

      const doc1 = await indexingService.getDocumentByPath(testSquadId, '/memory/test.md')
      expect(doc1!.title).toBe('Initial Title')
      const originalHash = doc1!.contentHash

      // Update content
      const updatedContent = `---
title: Updated Title
---

# Updated Content

With more text.`

      await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/test.md',
        content: updatedContent,
      })

      const doc2 = await indexingService.getDocumentByPath(testSquadId, '/memory/test.md')
      expect(doc2!.id).toBe(doc1!.id) // Same document
      expect(doc2!.title).toBe('Updated Title')
      expect(doc2!.contentHash).not.toBe(originalHash)

      // Verify chunks were replaced
      const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, doc2!.id))

      expect(chunks.some((c) => c.content.includes('Updated Content'))).toBe(true)
      expect(chunks.some((c) => c.content.includes('Initial Content'))).toBe(false)
    })

    it('skips re-indexing when content unchanged', async () => {
      const content = `---
title: Static Doc
---

# Static Content`

      const result1 = await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/static.md',
        content,
      })

      const result2 = await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/static.md',
        content,
      })

      expect(result1.success).toBe(true)
      expect(result2.success).toBe(true)
      expect(result2.skipped).toBe(true)
      expect(result2.chunksCreated).toBe(0)
    })

    it('handles files without frontmatter', async () => {
      const content = `# Simple Markdown

Just some content without YAML frontmatter.

## Section

More content here.`

      const result = await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/simple.md',
        content,
      })

      expect(result.success).toBe(true)

      const doc = await indexingService.getDocumentByPath(testSquadId, '/memory/simple.md')
      expect(doc).toBeDefined()
      expect(doc!.frontmatter).toEqual({})
      expect(doc!.title).toBe('Simple Markdown') // Extracted from first heading
    })

    it('handles empty files gracefully', async () => {
      const result = await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/empty.md',
        content: '',
      })

      expect(result.success).toBe(true)

      const doc = await indexingService.getDocumentByPath(testSquadId, '/memory/empty.md')
      expect(doc).toBeDefined()

      const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, doc!.id))

      expect(chunks.length).toBe(0)
    })

    it('preserves unchanged chunks and their embeddings', async () => {
      // Index initial document with two distinct paragraphs
      const content1 = `---
title: Chunk Test
---

# Document Title

First paragraph content that will stay the same.

# Second Section

Second paragraph that will be modified.`

      const result1 = await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/chunk-test.md',
        content: content1,
      })

      expect(result1.success).toBe(true)
      const docId = result1.documentId!

      // Get chunks and simulate embedding generation on the first chunk
      const chunks1 = await db
        .select()
        .from(memoryChunks)
        .where(eq(memoryChunks.documentId, docId))
        .orderBy(memoryChunks.chunkIndex)

      expect(chunks1.length).toBeGreaterThan(0)

      // Find the chunk containing "First paragraph" and give it a fake embedding
      const firstChunk = chunks1.find((c) => c.content.includes('First paragraph'))
      expect(firstChunk).toBeDefined()

      // Simulate embedding by setting a marker in metadata (embeddings require pgvector)
      await db
        .update(memoryChunks)
        .set({ metadata: { hasEmbedding: true, embeddedAt: new Date().toISOString() } })
        .where(eq(memoryChunks.id, firstChunk!.id))

      // Re-index with only the second paragraph changed
      const content2 = `---
title: Chunk Test
---

# Document Title

First paragraph content that will stay the same.

# Second Section

Second paragraph that HAS BEEN MODIFIED.`

      const result2 = await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/chunk-test.md',
        content: content2,
      })

      expect(result2.success).toBe(true)
      expect(result2.chunksPreserved).toBeGreaterThan(0)

      // Verify the chunk with "First paragraph" still has its metadata (embedding preserved)
      const chunks2 = await db
        .select()
        .from(memoryChunks)
        .where(eq(memoryChunks.documentId, docId))
        .orderBy(memoryChunks.chunkIndex)

      const preservedChunk = chunks2.find((c) => c.content.includes('First paragraph'))
      expect(preservedChunk).toBeDefined()
      expect((preservedChunk!.metadata as Record<string, unknown>).hasEmbedding).toBe(true)

      // Verify the modified chunk exists with new content
      const modifiedChunk = chunks2.find((c) => c.content.includes('HAS BEEN MODIFIED'))
      expect(modifiedChunk).toBeDefined()
    })

    it('stores line numbers in chunks', async () => {
      const content = `# First Section

Content for first section.

# Second Section

Content for second section.

# Third Section

Content for third section.`

      await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/lines.md',
        content,
      })

      const doc = await indexingService.getDocumentByPath(testSquadId, '/memory/lines.md')
      const chunks = await db
        .select()
        .from(memoryChunks)
        .where(eq(memoryChunks.documentId, doc!.id))
        .orderBy(memoryChunks.chunkIndex)

      // Each chunk should have line numbers
      for (const chunk of chunks) {
        expect(chunk.startLine).toBeGreaterThan(0)
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine!)
      }

      // Later chunks should have higher line numbers
      if (chunks.length >= 2) {
        expect(chunks[1].startLine).toBeGreaterThan(chunks[0].startLine!)
      }
    })
  })

  describe('indexFiles', () => {
    it('indexes multiple files in batch', async () => {
      const files = [
        {
          path: '/memory/doc1.md',
          content: `---
title: Doc 1
---

# Document 1`,
        },
        {
          path: '/memory/doc2.md',
          content: `---
title: Doc 2
---

# Document 2

Links to [[doc1]].`,
        },
        {
          path: '/memory/doc3.md',
          content: `---
title: Doc 3
---

# Document 3`,
        },
      ]

      const results = await indexingService.indexFiles(testSquadId, files)

      expect(results.length).toBe(3)
      expect(results.every((r) => r.success)).toBe(true)

      const docs = await db.select().from(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))

      expect(docs.length).toBe(3)
    })
  })

  describe('deleteDocument', () => {
    it('deletes document and cascades to chunks and links', async () => {
      const content = `---
title: To Delete
---

# Will Be Deleted

Link to [[other]].`

      await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/to-delete.md',
        content,
      })

      const doc = await indexingService.getDocumentByPath(testSquadId, '/memory/to-delete.md')
      expect(doc).toBeDefined()

      // Verify chunks exist
      const chunksBefore = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, doc!.id))
      expect(chunksBefore.length).toBeGreaterThan(0)

      // Delete document
      await indexingService.deleteDocument(testSquadId, '/memory/to-delete.md')

      // Verify document is gone
      const docAfter = await indexingService.getDocumentByPath(testSquadId, '/memory/to-delete.md')
      expect(docAfter).toBeUndefined()

      // Verify chunks are gone (cascaded)
      const chunksAfter = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, doc!.id))
      expect(chunksAfter.length).toBe(0)
    })
  })

  describe('link resolution', () => {
    it('resolves links to existing documents', async () => {
      // First create the target document
      await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/target.md',
        content: `---
title: Target Doc
---

# Target Document`,
      })

      const targetDoc = await indexingService.getDocumentByPath(testSquadId, '/memory/target.md')

      // Now create a document that links to it
      await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/source.md',
        content: `---
title: Source Doc
---

# Source Document

See [[target]] for more info.`,
      })

      const sourceDoc = await indexingService.getDocumentByPath(testSquadId, '/memory/source.md')
      const links = await db.select().from(memoryLinks).where(eq(memoryLinks.sourceDocumentId, sourceDoc!.id))

      expect(links.length).toBe(1)
      expect(links[0].targetDocumentId).toBe(targetDoc!.id)
    })

    it('creates unresolved links for non-existent targets', async () => {
      await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/orphan.md',
        content: `---
title: Orphan Doc
---

# Orphan

Links to [[nonexistent]].`,
      })

      const doc = await indexingService.getDocumentByPath(testSquadId, '/memory/orphan.md')
      const links = await db.select().from(memoryLinks).where(eq(memoryLinks.sourceDocumentId, doc!.id))

      expect(links.length).toBe(1)
      expect(links[0].targetDocumentId).toBeNull()
      expect(links[0].targetRaw).toBe('[[nonexistent]]')
    })
  })
})
