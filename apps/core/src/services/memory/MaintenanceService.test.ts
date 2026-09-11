/**
 * Memory Maintenance Service Tests
 *
 * Tests for non-destructive memory maintenance operations:
 * - Frontmatter normalization
 * - Broken link detection
 * - Stale document marking
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { db } from '../../db'
import { squads, memoryDocuments, memoryChunks, memoryLinks, squadSourceConfigs } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { ensureSquadMemoryPath } from './paths'

import { MaintenanceService } from './MaintenanceService'
import { SquadSourceConfig } from '../../entities/SquadSourceConfig'

describe('Memory Maintenance Runner', () => {
  let testSquadId: string
  let memoryPath: string

  beforeEach(async () => {
    // Create a test squad
    const [squad] = await db
      .insert(squads)
      .values({
        name: 'Test Squad',
        purpose: 'Testing maintenance',
        metadata: { memory: { enabled: true } },
      })
      .returning()
    testSquadId = squad.id

    // Ensure memory directory exists
    memoryPath = ensureSquadMemoryPath(testSquadId)
    mkdirSync(memoryPath, { recursive: true })
  })

  afterEach(async () => {
    // Clean up test data
    await db.delete(memoryLinks).where(eq(memoryLinks.squadId, testSquadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(squadSourceConfigs).where(eq(squadSourceConfigs.squadId, testSquadId))
    await db.delete(squads).where(eq(squads.id, testSquadId))

    // Clean up memory directory
    if (existsSync(memoryPath)) {
      rmSync(memoryPath, { recursive: true, force: true })
    }

    // Reset singleton
    MaintenanceService._reset()
  })

  describe('runMaintenance', () => {
    it('returns report with all maintenance results', async () => {
      // Create a test file
      writeFileSync(
        join(memoryPath, 'test.md'),
        `---
title: Test Doc
---

# Test

Content here.`
      )

      const report = await MaintenanceService.instance().runForSquad(testSquadId)

      expect(report).toBeDefined()
      expect(report.squadId).toBe(testSquadId)
      expect(typeof report.brokenLinks).toBe('number')
      expect(typeof report.staleDocuments).toBe('number')
      expect(typeof report.normalizedFiles).toBe('number')
      expect(report.errors).toEqual([])
    })

    it('does not delete any files (non-destructive)', async () => {
      // Create test files
      writeFileSync(join(memoryPath, 'keep1.md'), '# Keep 1')
      writeFileSync(join(memoryPath, 'keep2.md'), '# Keep 2')

      await MaintenanceService.instance().runForSquad(testSquadId)

      // Verify files still exist
      expect(existsSync(join(memoryPath, 'keep1.md'))).toBe(true)
      expect(existsSync(join(memoryPath, 'keep2.md'))).toBe(true)
    })
  })

  describe('detectBrokenLinks', () => {
    it('detects links to non-existent documents', async () => {
      // Create a document with a link to a non-existent target
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

      // Create a broken link (targetDocumentId is null)
      await db.insert(memoryLinks).values({
        squadId: testSquadId,
        sourceDocumentId: doc.id,
        targetRaw: '[[NonExistent]]',
        targetDocumentId: null,
        targetHeading: null,
      })

      const brokenLinks = await MaintenanceService.instance().detectBrokenLinks(testSquadId)

      expect(brokenLinks).toHaveLength(1)
      expect(brokenLinks[0].targetRaw).toBe('[[NonExistent]]')
    })

    it('returns empty array when all links are valid', async () => {
      // Create two documents
      const [doc1, doc2] = await db
        .insert(memoryDocuments)
        .values([
          {
            squadId: testSquadId,
            sourceType: 'memory_file',
            sourceId: '/memory/doc1.md',
            title: 'Doc 1',
            path: '/memory/doc1.md',
            contentHash: 'abc123',
            updatedAt: new Date(),
          },
          {
            squadId: testSquadId,
            sourceType: 'memory_file',
            sourceId: '/memory/doc2.md',
            title: 'Doc 2',
            path: '/memory/doc2.md',
            contentHash: 'def456',
            updatedAt: new Date(),
          },
        ])
        .returning()

      // Create a valid link
      await db.insert(memoryLinks).values({
        squadId: testSquadId,
        sourceDocumentId: doc1.id,
        targetRaw: '[[Doc 2]]',
        targetDocumentId: doc2.id,
        targetHeading: null,
      })

      const brokenLinks = await MaintenanceService.instance().detectBrokenLinks(testSquadId)

      expect(brokenLinks).toHaveLength(0)
    })
  })

  describe('retention policies', () => {
    it('deletes adapter documents older than configured retentionDays', async () => {
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      const recentDate = new Date()
      await SquadSourceConfig.upsert({
        squadId: testSquadId,
        sourceType: 'memory_file',
        policy: { version: 1, retentionDays: 5 },
      })
      await db.insert(memoryDocuments).values([
        {
          squadId: testSquadId,
          sourceType: 'memory_file',
          sourceId: '/memory/old.md',
          title: 'Old Doc',
          path: '/memory/old.md',
          contentHash: 'old123',
          updatedAt: oldDate,
        },
        {
          squadId: testSquadId,
          sourceType: 'memory_file',
          sourceId: '/memory/new.md',
          title: 'New Doc',
          path: '/memory/new.md',
          contentHash: 'new123',
          updatedAt: recentDate,
        },
        {
          squadId: testSquadId,
          sourceType: 'agent_thread',
          sourceId: 'agent-1',
          title: 'Thread',
          path: null,
          contentHash: 'thread123',
          updatedAt: oldDate,
        },
      ])

      await MaintenanceService.instance().runForSquad(testSquadId, { normalize: false })

      const docs = await db.select().from(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
      expect(docs.map((doc) => doc.sourceId).sort()).toEqual(['/memory/new.md', 'agent-1'])
    })
  })

  describe('findStaleDocuments', () => {
    it('finds documents not updated in specified days', async () => {
      // Create old document (60 days ago)
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 60)

      await db.insert(memoryDocuments).values({
        squadId: testSquadId,
        sourceType: 'memory_file',
        sourceId: '/memory/old.md',
        title: 'Old Doc',
        path: '/memory/old.md',
        contentHash: 'old123',
        updatedAt: oldDate,
      })

      // Create recent document
      await db.insert(memoryDocuments).values({
        squadId: testSquadId,
        sourceType: 'memory_file',
        sourceId: '/memory/new.md',
        title: 'New Doc',
        path: '/memory/new.md',
        contentHash: 'new123',
        updatedAt: new Date(),
      })

      const stale = await MaintenanceService.instance().findStaleDocuments(testSquadId, 30)

      expect(stale).toHaveLength(1)
      expect(stale[0].path).toBe('/memory/old.md')
    })

    it('excludes system files from stale detection', async () => {
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 60)

      // Create old system document
      await db.insert(memoryDocuments).values({
        squadId: testSquadId,
        sourceType: 'memory_file',
        sourceId: '/memory/_system/sync-state.json',
        title: 'Sync State',
        path: '/memory/_system/sync-state.json',
        contentHash: 'sys123',
        updatedAt: oldDate,
      })

      const stale = await MaintenanceService.instance().findStaleDocuments(testSquadId, 30)

      expect(stale).toHaveLength(0)
    })
  })

  describe('normalizeFrontmatter', () => {
    it('adds missing updatedAt to frontmatter', async () => {
      const filePath = join(memoryPath, 'missing-updated.md')
      writeFileSync(
        filePath,
        `---
title: Missing UpdatedAt
kind: decision
---

# Content`
      )

      const result = await MaintenanceService.instance().normalizeFrontmatter(testSquadId, '/memory/missing-updated.md')

      expect(result.success).toBe(true)
      expect(result.changes).toContain('updatedAt')

      // Verify file was updated
      const content = readFileSync(filePath, 'utf-8')
      expect(content).toContain('updatedAt:')
    })

    it('adds missing id to frontmatter', async () => {
      const filePath = join(memoryPath, 'missing-id.md')
      writeFileSync(
        filePath,
        `---
title: Missing ID
---

# Content`
      )

      const result = await MaintenanceService.instance().normalizeFrontmatter(testSquadId, '/memory/missing-id.md')

      expect(result.success).toBe(true)

      const content = readFileSync(filePath, 'utf-8')
      expect(content).toContain('id:')
    })

    it('does not modify files with complete frontmatter', async () => {
      const filePath = join(memoryPath, 'complete.md')
      const originalContent = `---
id: mem_123
title: Complete Doc
kind: decision
updatedAt: 2026-02-26T00:00:00Z
---

# Content`
      writeFileSync(filePath, originalContent)

      const result = await MaintenanceService.instance().normalizeFrontmatter(testSquadId, '/memory/complete.md')

      expect(result.success).toBe(true)
      expect(result.changes).toEqual([])

      // Verify file was not modified
      const content = readFileSync(filePath, 'utf-8')
      expect(content).toBe(originalContent)
    })

    it('handles files without frontmatter', async () => {
      const filePath = join(memoryPath, 'no-frontmatter.md')
      writeFileSync(filePath, '# Just a heading\n\nSome content.')

      const result = await MaintenanceService.instance().normalizeFrontmatter(testSquadId, '/memory/no-frontmatter.md')

      // Should succeed - adds minimal frontmatter
      expect(result.success).toBe(true)

      const content = readFileSync(filePath, 'utf-8')
      expect(content).toContain('---')
    })
  })
})
