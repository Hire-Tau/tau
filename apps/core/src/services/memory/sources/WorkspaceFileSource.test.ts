import { describe, it, expect, afterEach, beforeAll, afterAll } from 'bun:test'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../db'
import { squads, memoryDocuments, memoryChunks, memoryLinks } from '../../../db/schema'
import { WorkspaceFileSource } from './WorkspaceFileSource'

describe('WorkspaceFileSource', () => {
  const testSquadId = crypto.randomUUID()
  const source = new WorkspaceFileSource()

  beforeAll(async () => {
    await db.insert(squads).values({
      id: testSquadId,
      name: 'WorkspaceFileSource Test Squad',
      purpose: 'Testing WorkspaceFileSource',
      status: 'active',
    })
  })

  afterAll(async () => {
    await db.delete(memoryLinks).where(eq(memoryLinks.squadId, testSquadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(squads).where(eq(squads.id, testSquadId))
  })

  afterEach(async () => {
    await db.delete(memoryLinks).where(eq(memoryLinks.squadId, testSquadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
  })

  describe('sourceType', () => {
    it('returns "workspace_file"', () => {
      expect(source.sourceType).toBe('workspace_file')
    })
  })

  describe('index()', () => {
    it('returns an error', async () => {
      const result = await source.index(testSquadId, '/workspace/test.md')
      expect(result.success).toBe(false)
      expect(result.error).toContain('indexContent')
    })
  })

  describe('indexAll()', () => {
    it('returns empty array', async () => {
      const results = await source.indexAll(testSquadId)
      expect(results).toEqual([])
    })
  })

  describe('indexContent()', () => {
    it('indexes a markdown file with correct source type, title, and chunks', async () => {
      const content = `---
title: Architecture Overview
---

# Architecture

This describes the system architecture.

## Components

The system has several key components.

## Data Flow

Data flows through the pipeline.
`
      const result = await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/docs/architecture.md',
        content,
      })

      expect(result.success).toBe(true)
      expect(result.documentId).toBeDefined()
      expect(result.chunksCreated).toBeGreaterThan(0)

      // Verify document in DB
      const [doc] = await db.select().from(memoryDocuments).where(eq(memoryDocuments.id, result.documentId!))

      expect(doc.sourceType).toBe('workspace_file')
      expect(doc.title).toBe('Architecture Overview')
      expect(doc.path).toBe('/workspace/docs/architecture.md')

      // Verify chunks exist
      const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, result.documentId!))

      expect(chunks.length).toBe(result.chunksCreated)
    })

    it('extracts title from first heading when no frontmatter title', async () => {
      const content = `# My Heading\n\nSome content here.`
      const result = await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/notes.md',
        content,
      })

      const [doc] = await db.select().from(memoryDocuments).where(eq(memoryDocuments.id, result.documentId!))

      expect(doc.title).toBe('My Heading')
    })

    it('falls back to filename for title when no heading', async () => {
      const content = `Some plain content without a heading.`
      const result = await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/config.md',
        content,
      })

      const [doc] = await db.select().from(memoryDocuments).where(eq(memoryDocuments.id, result.documentId!))

      expect(doc.title).toBe('config')
    })

    it('indexes a non-markdown file with chunks', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}: some code here`).join('\n')
      const result = await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/src/main.ts',
        content: lines,
      })

      expect(result.success).toBe(true)
      expect(result.chunksCreated).toBeGreaterThan(0)

      const [doc] = await db.select().from(memoryDocuments).where(eq(memoryDocuments.id, result.documentId!))

      expect(doc.sourceType).toBe('workspace_file')
      expect(doc.title).toBe('main')
    })

    it('skips unchanged files via content hash', async () => {
      const content = '# Test\n\nSome content.'

      const result1 = await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/test.md',
        content,
      })
      expect(result1.success).toBe(true)
      expect(result1.skipped).toBeUndefined()

      const result2 = await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/test.md',
        content,
      })
      expect(result2.success).toBe(true)
      expect(result2.skipped).toBe(true)
      expect(result2.chunksCreated).toBe(0)
      expect(result2.documentId).toBe(result1.documentId)
    })

    it('re-indexes when content changes', async () => {
      const result1 = await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/changing.md',
        content: '# Version 1\n\nOriginal content.',
      })
      expect(result1.success).toBe(true)

      const result2 = await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/changing.md',
        content: '# Version 2\n\nUpdated content with more details.',
      })
      expect(result2.success).toBe(true)
      expect(result2.skipped).toBeUndefined()
      expect(result2.documentId).toBe(result1.documentId)
      expect(result2.chunksCreated).toBeGreaterThan(0)
    })

    it('creates wikilinks for markdown files', async () => {
      const content = '# Linked Doc\n\nSee [[other-doc]] and [[another#section]].'
      const result = await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/linked.md',
        content,
      })

      expect(result.success).toBe(true)
      expect(result.linksCreated).toBe(2)

      const links = await db.select().from(memoryLinks).where(eq(memoryLinks.sourceDocumentId, result.documentId!))

      expect(links.length).toBe(2)
    })
  })

  describe('exists()', () => {
    it('returns false when document does not exist', async () => {
      const result = await source.exists(testSquadId, '/workspace/nonexistent.md')
      expect(result).toBe(false)
    })

    it('returns true when document exists', async () => {
      await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/exists.md',
        content: '# Exists\n\nContent.',
      })

      const result = await source.exists(testSquadId, '/workspace/exists.md')
      expect(result).toBe(true)
    })
  })

  describe('remove()', () => {
    it('removes a specific document', async () => {
      const result = await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/to-remove.md',
        content: '# Remove Me\n\nContent.',
      })
      expect(result.success).toBe(true)

      await source.remove(testSquadId, '/workspace/to-remove.md')

      const exists = await source.exists(testSquadId, '/workspace/to-remove.md')
      expect(exists).toBe(false)

      // Chunks should be gone too (cascade)
      const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, result.documentId!))
      expect(chunks.length).toBe(0)
    })
  })

  describe('reconcile()', () => {
    it('removes docs for deleted files', async () => {
      await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/keep.md',
        content: '# Keep\n\nKeep this.',
      })
      await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/delete.md',
        content: '# Delete\n\nDelete this.',
      })

      const removed = await source.reconcile(testSquadId, ['/workspace/keep.md'])
      expect(removed).toEqual({ removed: 1 })

      const keepExists = await source.exists(testSquadId, '/workspace/keep.md')
      expect(keepExists).toBe(true)

      const deleteExists = await source.exists(testSquadId, '/workspace/delete.md')
      expect(deleteExists).toBe(false)
    })

    it('removes all docs when currentPaths is empty', async () => {
      await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/a.md',
        content: '# A\n\nContent.',
      })
      await source.indexContent({
        squadId: testSquadId,
        path: '/workspace/b.md',
        content: '# B\n\nContent.',
      })

      const removed = await source.reconcile(testSquadId, [])
      expect(removed).toEqual({ removed: 2 })

      const docs = await db
        .select()
        .from(memoryDocuments)
        .where(and(eq(memoryDocuments.squadId, testSquadId), eq(memoryDocuments.sourceType, 'workspace_file')))
      expect(docs.length).toBe(0)
    })
  })

  describe('sensitivity', () => {
    it('defaults indexed workspace files and chunks to internal', async () => {
      const result = await source.indexContent({
        squadId: testSquadId,
        path: 'src/index.ts',
        content: 'export const x = 1\n',
      })
      expect(result.success).toBe(true)
      const [doc] = await db.select().from(memoryDocuments).where(eq(memoryDocuments.id, result.documentId!))
      expect(doc.sensitivity).toBe('internal')
      const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, doc.id))
      expect(chunks.length).toBeGreaterThan(0)
      for (const chunk of chunks) expect(chunk.sensitivity).toBe('internal')
    })
  })
})
