/**
 * Workspace file memory source.
 *
 * Indexes files from sandbox workspace pods into the memory system.
 * Content is provided externally (no filesystem access) via indexContent().
 * Supports markdown (with frontmatter, wikilinks) and plain text files.
 */

import { basename, extname } from 'path'
import { eq, and, inArray, notInArray } from 'drizzle-orm'
import { db } from '../../../db'
import { memoryDocuments } from '../../../db/schema'
import { SquadSourceConfig } from '../../../entities/SquadSourceConfig'
import { parseFrontmatter, parseWikilinks } from '../parser'
import { BaseMemorySourceAdapter, sourceCapabilities, type DiscoveredItem, type FetchedContent } from './adapter'
import { IndexedDocumentWriter } from './IndexedDocumentWriter'
import { mergePolicyErrors, validateBaseIngestionPolicy, validateStringArrayScope } from './policy'
import type { IndexResult } from './types'

// ============================================================================
// Types
// ============================================================================

export interface WorkspaceFileInput {
  squadId: string
  path: string
  content: string
}

interface MemoryDocument {
  id: string
  squadId: string
  sourceType: string
  sourceId: string
  title: string | null
  path: string | null
  frontmatter: Record<string, unknown>
  sensitivity: 'internal'
  contentHash: string
  createdAt: Date
  updatedAt: Date
}

// ============================================================================
// Constants
// ============================================================================

const SOURCE_TYPE = 'workspace_file'
const HEADING_REGEX = /^#\s+(.+)$/m

// ============================================================================
// Class
// ============================================================================

export class WorkspaceFileSource extends BaseMemorySourceAdapter {
  private static _instance: WorkspaceFileSource | null = null

  readonly sourceType = SOURCE_TYPE
  readonly capabilities = sourceCapabilities(['searchable', 'readable', 'external'])
  readonly defaultSensitivity = 'internal' as const

  constructor() {
    super()
  }

  /**
   * Get the shared WorkspaceFileSource instance.
   */
  static instance(): WorkspaceFileSource {
    if (!WorkspaceFileSource._instance) {
      WorkspaceFileSource._instance = new WorkspaceFileSource()
    }
    return WorkspaceFileSource._instance
  }

  /**
   * Reset the shared instance (for testing).
   */
  static _reset(): void {
    WorkspaceFileSource._instance = null
  }

  validatePolicy(policy: unknown): string[] | null {
    return mergePolicyErrors(validateBaseIngestionPolicy(policy), validateStringArrayScope(policy, 'paths'))
  }

  // ==========================================================================
  // MemorySourceAdapter Interface
  // ==========================================================================

  async list(_squadId: string): Promise<DiscoveredItem[]> {
    return []
  }

  async fetch(_squadId: string, _sourceId: string): Promise<FetchedContent | null> {
    return null
  }

  /**
   * Not supported — workspace files must be provided via indexContent().
   */
  async index(_squadId: string, _sourceId: string): Promise<IndexResult> {
    return {
      success: false,
      chunksCreated: 0,
      linksCreated: 0,
      error: 'WorkspaceFileSource does not support index(). Use indexContent() instead.',
    }
  }

  /**
   * Not supported — workspace files are pushed from sandbox pods.
   */
  async indexAll(_squadId: string): Promise<IndexResult[]> {
    return []
  }

  /**
   * Check if a workspace file document exists in the database.
   */
  async exists(squadId: string, sourceId: string): Promise<boolean> {
    const doc = await this.getDocumentBySourceId(squadId, sourceId)
    return !!doc
  }

  /**
   * Remove a workspace file document and all associated chunks/links.
   */
  async remove(squadId: string, sourceId: string): Promise<void> {
    const doc = await this.getDocumentBySourceId(squadId, sourceId)
    if (doc) {
      await db.delete(memoryDocuments).where(eq(memoryDocuments.id, doc.id))
    }
  }

  // ==========================================================================
  // Workspace-specific Methods
  // ==========================================================================

  /**
   * Index a workspace file from externally provided content.
   */
  async indexContent(input: WorkspaceFileInput): Promise<IndexResult> {
    const { squadId, path, content } = input
    const config = await SquadSourceConfig.findBySquadAndType(squadId, SOURCE_TYPE)
    if (config?.enabled === false) return { success: true, chunksCreated: 0, linksCreated: 0, skipped: true }
    const isMarkdown = path.endsWith('.md')
    const parsed = isMarkdown ? parseFrontmatter(content) : { frontmatter: {}, content }
    const title = isMarkdown
      ? this.extractTitle(parsed.frontmatter, parsed.content, path)
      : this.extractTitle({}, '', path)

    return IndexedDocumentWriter.instance().writeDocument({
      squadId,
      sourceType: SOURCE_TYPE,
      sourceId: path,
      fetched: {
        content: isMarkdown ? parsed.content : content,
        frontmatter: parsed.frontmatter,
        title,
        path,
        wikilinks: isMarkdown ? parseWikilinks(content) : [],
        sensitivity: this.defaultSensitivity,
      },
      adapterDefaultSensitivity: this.defaultSensitivity,
      policy: config?.policy,
      chunker: isMarkdown ? 'markdown' : 'lines',
    })
  }

  /**
   * Reconcile workspace files — remove documents whose sourceId is not in currentPaths.
   */
  async reconcile(
    squadId: string,
    opts: { currentSourceIds?: string[] } | string[] = {}
  ): Promise<{ removed: number }> {
    const currentPaths = Array.isArray(opts) ? opts : (opts.currentSourceIds ?? [])
    if (currentPaths.length === 0) {
      // Remove all workspace_file docs for this squad
      const docs = await db
        .select({ id: memoryDocuments.id })
        .from(memoryDocuments)
        .where(and(eq(memoryDocuments.squadId, squadId), eq(memoryDocuments.sourceType, SOURCE_TYPE)))

      if (docs.length > 0) {
        await db.delete(memoryDocuments).where(
          inArray(
            memoryDocuments.id,
            docs.map((d) => d.id)
          )
        )
      }
      return { removed: docs.length }
    }

    const docsToRemove = await db
      .select({ id: memoryDocuments.id })
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          eq(memoryDocuments.sourceType, SOURCE_TYPE),
          notInArray(memoryDocuments.sourceId, currentPaths)
        )
      )

    if (docsToRemove.length > 0) {
      await db.delete(memoryDocuments).where(
        inArray(
          memoryDocuments.id,
          docsToRemove.map((d) => d.id)
        )
      )
    }

    return { removed: docsToRemove.length }
  }

  // ==========================================================================
  // Helper Functions
  // ==========================================================================

  /**
   * Extract title: frontmatter title → first heading → filename (no extension).
   */
  private extractTitle(frontmatter: Record<string, unknown>, content: string, filePath: string): string | null {
    if (frontmatter.title && typeof frontmatter.title === 'string') {
      return frontmatter.title
    }

    const match = content.match(HEADING_REGEX)
    if (match) {
      return match[1].trim()
    }

    // Fall back to filename without extension
    const filename = basename(filePath)
    const ext = extname(filename)
    return ext ? filename.slice(0, -ext.length) : filename
  }

  /**
   * Get a document by source ID.
   */
  private async getDocumentBySourceId(squadId: string, sourceId: string): Promise<MemoryDocument | undefined> {
    const [doc] = await db
      .select()
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          eq(memoryDocuments.sourceType, SOURCE_TYPE),
          eq(memoryDocuments.sourceId, sourceId)
        )
      )
      .limit(1)

    return doc as MemoryDocument | undefined
  }
}
