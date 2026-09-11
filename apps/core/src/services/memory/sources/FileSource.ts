/**
 * File-based memory source.
 *
 * Indexes markdown files from a squad's memory directory into the memory system.
 * Handles parsing, chunking, and database operations for file-based memories.
 */

import { readdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, relative } from 'path'
import { eq, and, inArray } from 'drizzle-orm'
import { db } from '../../../db'
import { memoryDocuments } from '../../../db/schema'
import { SquadSourceConfig } from '../../../entities/SquadSourceConfig'
import { parseFrontmatter, parseWikilinks } from '../parser'
import { ensureSquadMemoryPath } from '../paths'
import { parseSensitivity } from '../access/sensitivity'
import { BaseMemorySourceAdapter, sourceCapabilities, type DiscoveredItem, type FetchedContent } from './adapter'
import { IndexedDocumentWriter } from './IndexedDocumentWriter'
import { mergePolicyErrors, validateBaseIngestionPolicy, validateStringArrayScope } from './policy'
import type { IndexResult } from './types'

// ============================================================================
// Types
// ============================================================================

export interface FileContent {
  path: string
  content: string
}

// ============================================================================
// Class
// ============================================================================

export class FileSource extends BaseMemorySourceAdapter {
  private static _instance: FileSource | null = null

  readonly sourceType = 'file'
  readonly capabilities = sourceCapabilities(['searchable', 'readable', 'writable', 'incremental', 'external'])
  readonly defaultSensitivity = 'internal' as const

  constructor() {
    super()
  }

  /**
   * Get the shared FileSource instance.
   */
  static instance(): FileSource {
    if (!FileSource._instance) {
      FileSource._instance = new FileSource()
    }
    return FileSource._instance
  }

  /**
   * Reset the shared instance (for testing).
   */
  static _reset(): void {
    FileSource._instance = null
  }

  // ==========================================================================
  // MemorySourceAdapter Interface
  // ==========================================================================

  async list(squadId: string, opts: { since?: string; paths?: string[] } = {}): Promise<DiscoveredItem[]> {
    const config = await SquadSourceConfig.findBySquadAndType(squadId, 'memory_file')
    if (config?.enabled === false) return []
    const paths = opts.paths ?? getPolicyStringArray(config?.policy, 'paths')
    const memoryDir = ensureSquadMemoryPath(squadId)
    const filePaths = await this.collectMarkdownFiles(memoryDir)
    return filePaths
      .map((absolutePath) => ({ sourceId: `/memory/${relative(memoryDir, absolutePath)}` }))
      .filter((item) => !paths || matchesAnyPath(item.sourceId, paths))
  }

  validatePolicy(policy: unknown): string[] | null {
    return mergePolicyErrors(validateBaseIngestionPolicy(policy), validateStringArrayScope(policy, 'paths'))
  }

  async fetch(squadId: string, filePath: string): Promise<FetchedContent | null> {
    const memoryDir = ensureSquadMemoryPath(squadId)
    const relativePath = filePath.replace(/^\/memory\//, '')
    const absolutePath = join(memoryDir, relativePath)
    if (!existsSync(absolutePath)) return null
    const content = await readFile(absolutePath, 'utf-8')
    const { frontmatter, content: bodyContent } = parseFrontmatter(content)
    return {
      content: bodyContent,
      frontmatter,
      path: filePath,
      wikilinks: parseWikilinks(content),
      sensitivity: parseSensitivity(frontmatter.sensitivity),
    }
  }

  /**
   * Index a single file by its memory path (e.g. `/memory/decisions/auth.md`).
   */
  async index(squadId: string, filePath: string): Promise<IndexResult> {
    const fetched = await this.fetch(squadId, filePath)
    if (!fetched) {
      return { success: false, chunksCreated: 0, linksCreated: 0, error: `File not found: ${filePath}` }
    }
    const config = await SquadSourceConfig.findBySquadAndType(squadId, 'memory_file')
    if (config?.enabled === false) return { success: true, chunksCreated: 0, linksCreated: 0, skipped: true }
    return IndexedDocumentWriter.instance().writeDocument({
      squadId,
      sourceType: 'memory_file',
      sourceId: filePath,
      fetched,
      adapterDefaultSensitivity: this.defaultSensitivity,
      policy: config?.policy,
      chunker: 'markdown',
    })
  }

  async reconcile(squadId: string, opts: { currentSourceIds?: string[] } = {}): Promise<{ removed: number }> {
    const live = new Set(opts.currentSourceIds ?? (await this.list(squadId)).map((item) => item.sourceId))
    const docs = await db
      .select({ id: memoryDocuments.id, sourceId: memoryDocuments.sourceId })
      .from(memoryDocuments)
      .where(and(eq(memoryDocuments.squadId, squadId), eq(memoryDocuments.sourceType, 'memory_file')))
    const stale = docs.filter((doc) => !live.has(doc.sourceId)).map((doc) => doc.id)
    if (stale.length > 0) await db.delete(memoryDocuments).where(inArray(memoryDocuments.id, stale))
    return { removed: stale.length }
  }

  /**
   * Check if a file exists on the filesystem.
   */
  async exists(squadId: string, filePath: string): Promise<boolean> {
    const memoryDir = ensureSquadMemoryPath(squadId)
    const relativePath = filePath.replace(/^\/memory\//, '')
    const absolutePath = join(memoryDir, relativePath)
    return existsSync(absolutePath)
  }

  /**
   * Remove the document and all associated chunks/links from the database.
   */
  async remove(squadId: string, filePath: string): Promise<void> {
    await db
      .delete(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          eq(memoryDocuments.sourceType, 'memory_file'),
          eq(memoryDocuments.sourceId, filePath)
        )
      )
  }

  // ==========================================================================
  // Batch Operations
  // ==========================================================================

  /**
   * Index multiple files (batch operation).
   */
  async indexFiles(squadId: string, files: FileContent[]): Promise<IndexResult[]> {
    const results: IndexResult[] = []

    for (const file of files) {
      const result = await this.indexFileContent({
        squadId,
        path: file.path,
        content: file.content,
      })
      results.push(result)
    }

    return results
  }

  // ==========================================================================
  // Core Indexing Logic
  // ==========================================================================

  /**
   * Index a single file from its content (extracted from IndexingService.indexFile).
   */
  private async indexFileContent(input: { squadId: string; path: string; content: string }): Promise<IndexResult> {
    const { squadId, path, content } = input
    const { frontmatter, content: bodyContent } = parseFrontmatter(content)
    const config = await SquadSourceConfig.findBySquadAndType(squadId, 'memory_file')
    if (config?.enabled === false) return { success: true, chunksCreated: 0, linksCreated: 0, skipped: true }
    return IndexedDocumentWriter.instance().writeDocument({
      squadId,
      sourceType: 'memory_file',
      sourceId: path,
      fetched: {
        content: bodyContent,
        frontmatter,
        path,
        wikilinks: parseWikilinks(content),
        sensitivity: parseSensitivity(frontmatter.sensitivity),
      },
      adapterDefaultSensitivity: this.defaultSensitivity,
      policy: config?.policy,
      chunker: 'markdown',
    })
  }

  // ==========================================================================
  // Helper Functions
  // ==========================================================================

  /**
   * Recursively collect all markdown files in a directory.
   */
  private async collectMarkdownFiles(dir: string): Promise<string[]> {
    const files: string[] = []

    try {
      const entries = await readdir(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = join(dir, entry.name)

        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) {
            const subFiles = await this.collectMarkdownFiles(fullPath)
            files.push(...subFiles)
          }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(fullPath)
        }
      }
    } catch {
      // Directory might not exist yet
    }

    return files
  }
}

function matchesAnyPath(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**')) return path.startsWith(pattern.slice(0, -3))
    if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1))
    return path === pattern
  })
}

function getPolicyStringArray(policy: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const scope = policy?.scope
  if (!scope || typeof scope !== 'object') return undefined
  const value = (scope as Record<string, unknown>)[key]
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
}
