import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import { squads, memoryDocuments, memoryChunks, memoryLinks, squadSourceConfigs } from '../../../db/schema'
import { FileSource } from './FileSource'
import { ensureSquadMemoryPath } from '../paths'
import { SquadSourceConfig } from '../../../entities/SquadSourceConfig'

describe('FileSource', () => {
  const testSquadId = crypto.randomUUID()
  const source = new FileSource()

  beforeAll(async () => {
    await db.insert(squads).values({
      id: testSquadId,
      name: 'FileSource Test Squad',
      purpose: 'Testing FileSource',
      status: 'active',
    })
  })

  afterAll(async () => {
    await db.delete(memoryLinks).where(eq(memoryLinks.squadId, testSquadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(squadSourceConfigs).where(eq(squadSourceConfigs.squadId, testSquadId))
    await db.delete(squads).where(eq(squads.id, testSquadId))
  })

  beforeEach(async () => {
    await db.delete(memoryLinks).where(eq(memoryLinks.squadId, testSquadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(squadSourceConfigs).where(eq(squadSourceConfigs.squadId, testSquadId))
  })

  describe('list', () => {
    it('filters files by policy scope paths when configured', async () => {
      const memoryPath = ensureSquadMemoryPath(testSquadId)
      await rm(memoryPath, { recursive: true, force: true })
      await mkdir(join(memoryPath, 'team'), { recursive: true })
      await mkdir(join(memoryPath, 'personal'), { recursive: true })
      await writeFile(join(memoryPath, 'team', 'plan.md'), '# Team plan')
      await writeFile(join(memoryPath, 'personal', 'notes.md'), '# Personal notes')
      await SquadSourceConfig.upsert({
        squadId: testSquadId,
        sourceType: 'memory_file',
        policy: { version: 1, scope: { paths: ['/memory/team/**'] } },
      })

      const items = await source.list(testSquadId)

      expect(items.map((item) => item.sourceId)).toEqual(['/memory/team/plan.md'])
    })
  })

  describe('sourceType', () => {
    it('returns "file"', () => {
      expect(source.sourceType).toBe('file')
    })
  })

  describe('indexFiles', () => {
    it('indexes a markdown file with frontmatter', async () => {
      const content = `---
title: Test Decision
kind: decision
---

# JWT Auth Decision

We decided to use JWT tokens for authentication.

## Rationale

JWTs are stateless and scalable.
`
      const results = await source.indexFiles(testSquadId, [{ path: '/memory/decisions/auth.md', content }])

      expect(results).toHaveLength(1)
      expect(results[0].success).toBe(true)
      expect(results[0].documentId).toBeDefined()
      expect(results[0].chunksCreated).toBeGreaterThan(0)
    })

    it('indexes multiple files in batch', async () => {
      const files = [
        {
          path: '/memory/docs/a.md',
          content: '# Doc A\n\nContent for doc A.',
        },
        {
          path: '/memory/docs/b.md',
          content: '# Doc B\n\nContent for doc B.',
        },
      ]

      const results = await source.indexFiles(testSquadId, files)

      expect(results).toHaveLength(2)
      expect(results[0].success).toBe(true)
      expect(results[1].success).toBe(true)
    })

    it('skips re-indexing unchanged content', async () => {
      const content = '# Test\n\nSome content.'
      const file = { path: '/memory/test.md', content }

      const [first] = await source.indexFiles(testSquadId, [file])
      expect(first.success).toBe(true)
      expect(first.skipped).toBeFalsy()

      const [second] = await source.indexFiles(testSquadId, [file])
      expect(second.success).toBe(true)
      expect(second.skipped).toBe(true)
      expect(second.chunksCreated).toBe(0)
    })

    it('re-indexes when content changes', async () => {
      const file = { path: '/memory/evolving.md', content: '# V1\n\nOriginal.' }
      const [first] = await source.indexFiles(testSquadId, [file])
      expect(first.success).toBe(true)

      const updated = { path: '/memory/evolving.md', content: '# V2\n\nUpdated content.' }
      const [second] = await source.indexFiles(testSquadId, [updated])
      expect(second.success).toBe(true)
      expect(second.skipped).toBeFalsy()
      expect(second.chunksCreated).toBeGreaterThan(0)
    })

    it('preserves unchanged chunks during partial update', async () => {
      const content = `# Section 1

This section stays the same.

# Section 2

This section will change.
`
      await source.indexFiles(testSquadId, [{ path: '/memory/partial.md', content }])

      const updatedContent = `# Section 1

This section stays the same.

# Section 2

This section has been updated with new info.
`
      const [result] = await source.indexFiles(testSquadId, [{ path: '/memory/partial.md', content: updatedContent }])

      expect(result.success).toBe(true)
      // At least one chunk should be preserved (Section 1 unchanged)
      expect(result.chunksPreserved).toBeGreaterThan(0)
    })

    it('extracts title from frontmatter', async () => {
      const content = `---
title: My Custom Title
---

# Heading That Should Be Ignored

Content here.
`
      const [result] = await source.indexFiles(testSquadId, [{ path: '/memory/titled.md', content }])

      expect(result.success).toBe(true)

      const [doc] = await db.select().from(memoryDocuments).where(eq(memoryDocuments.id, result.documentId!))

      expect(doc.title).toBe('My Custom Title')
    })

    it('falls back to first heading for title', async () => {
      const content = '# First Heading\n\nSome text.'
      const [result] = await source.indexFiles(testSquadId, [{ path: '/memory/no-fm.md', content }])

      expect(result.success).toBe(true)

      const [doc] = await db.select().from(memoryDocuments).where(eq(memoryDocuments.id, result.documentId!))

      expect(doc.title).toBe('First Heading')
    })

    it('creates wikilinks', async () => {
      const content = `# Page With Links

See [[other-page]] and [[another-page#section]].
`
      const [result] = await source.indexFiles(testSquadId, [{ path: '/memory/linked.md', content }])

      expect(result.success).toBe(true)
      expect(result.linksCreated).toBe(2)

      const links = await db.select().from(memoryLinks).where(eq(memoryLinks.sourceDocumentId, result.documentId!))

      expect(links).toHaveLength(2)
    })
  })

  describe('remove', () => {
    it('removes document and associated data', async () => {
      const content = '# To Remove\n\nThis will be deleted.'
      const [result] = await source.indexFiles(testSquadId, [{ path: '/memory/removable.md', content }])
      expect(result.success).toBe(true)

      await source.remove(testSquadId, '/memory/removable.md')

      const docs = await db.select().from(memoryDocuments).where(eq(memoryDocuments.id, result.documentId!))

      expect(docs).toHaveLength(0)

      // Chunks should be cascade-deleted
      const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, result.documentId!))

      expect(chunks).toHaveLength(0)
    })

    it('is a no-op for non-existent documents', async () => {
      // Should not throw
      await source.remove(testSquadId, '/memory/nonexistent.md')
    })
  })

  describe('singleton', () => {
    it('returns same instance', () => {
      FileSource._reset()
      const a = FileSource.instance()
      const b = FileSource.instance()
      expect(a).toBe(b)
      FileSource._reset()
    })
  })

  describe('sensitivity', () => {
    it('uses frontmatter.sensitivity when present', async () => {
      const content = `---
title: Restricted Note
sensitivity: restricted
---

Body content.
`
      const [result] = await source.indexFiles(testSquadId, [{ path: '/memory/notes/secret.md', content }])
      expect(result.success).toBe(true)

      const [doc] = await db.select().from(memoryDocuments).where(eq(memoryDocuments.id, result.documentId!))
      expect(doc.sensitivity).toBe('restricted')
      const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, doc.id))
      expect(chunks.length).toBeGreaterThan(0)
      for (const chunk of chunks) expect(chunk.sensitivity).toBe('restricted')
    })

    it('defaults to internal when frontmatter has no sensitivity or an unknown value', async () => {
      for (const [path, content] of [
        ['/memory/notes/plain.md', `---\ntitle: Plain Note\n---\n\nBody content.\n`],
        ['/memory/notes/bad.md', `---\ntitle: Bad Tier\nsensitivity: top-secret\n---\n\nBody content.\n`],
      ] as const) {
        const [result] = await source.indexFiles(testSquadId, [{ path, content }])
        expect(result.success).toBe(true)
        const [doc] = await db.select().from(memoryDocuments).where(eq(memoryDocuments.id, result.documentId!))
        expect(doc.sensitivity).toBe('internal')
      }
    })

    it('updates preserved chunks when only frontmatter sensitivity changes', async () => {
      const path = '/memory/notes/reclassified.md'
      const body = 'Body content that stays the same.\n'
      await source.indexFiles(testSquadId, [
        {
          path,
          content: `---
title: Reclassified
sensitivity: internal
---

${body}`,
        },
      ])
      const [result] = await source.indexFiles(testSquadId, [
        {
          path,
          content: `---
title: Reclassified
sensitivity: restricted
---

${body}`,
        },
      ])
      expect(result.success).toBe(true)
      expect(result.chunksPreserved).toBeGreaterThan(0)

      const [doc] = await db.select().from(memoryDocuments).where(eq(memoryDocuments.id, result.documentId!))
      expect(doc.sensitivity).toBe('restricted')
      const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, doc.id))
      for (const chunk of chunks) expect(chunk.sensitivity).toBe('restricted')
    })
  })
})
