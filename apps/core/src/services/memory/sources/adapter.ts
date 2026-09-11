import { and, eq, inArray, type sql } from 'drizzle-orm'
import { db } from '../../../db'
import { memoryDocuments } from '../../../db/schema'
import type { SensitivityTier } from '../access/sensitivity'
import type { ContentChunk, WikiLink } from '../parser'
import type { IndexResult } from './types'

export type SourceCapability = 'searchable' | 'readable' | 'writable' | 'incremental' | 'external' | 'live'

export interface SourceCapabilities {
  has(cap: SourceCapability): boolean
  readonly all: ReadonlySet<SourceCapability>
}

export function sourceCapabilities(capabilities: SourceCapability[]): SourceCapabilities {
  const all = new Set(capabilities)
  return {
    all,
    has(cap: SourceCapability) {
      return all.has(cap)
    },
  }
}

export interface DiscoveredItem {
  /** Adapter-stable ID. e.g. memory path, agent ID, workspace path, slack ts. */
  sourceId: string
  /** Optional opaque cursor for incremental sync (e.g. updated_at, etag). */
  cursor?: string
}

export interface FetchedContent {
  /** Raw text body fed into chunker. Empty string is legal (e.g. deleted). */
  content: string
  /** Document-level frontmatter (kind, tags, importance, sensitivity, ...). */
  frontmatter?: Record<string, unknown>
  /** Display title (optional). */
  title?: string | null
  /** Path-shaped sources fill this; ID-shaped sources leave null. */
  path?: string | null
  /** Precomputed chunks for sources that require deterministic chunk boundaries. */
  chunks?: ContentChunk[]
  /** Per-source metadata that should sit on every emitted chunk (event ts/actor). */
  chunkMetadata?: Record<string, unknown>
  /** Per-chunk metadata derived after chunking (e.g. event metadata by overlapping line range). */
  chunkMetadataForChunk?: (chunk: ContentChunk) => Record<string, unknown>
  /** Override sensitivity. If absent, adapter default is used. */
  sensitivity?: SensitivityTier
  /** Wikilinks parsed from content (markdown sources only). */
  wikilinks?: WikiLink[]
}

/**
 * Indexed adapter lifecycle:
 * discover  → adapter.list(squadId)                returns DiscoveredItem[]
 * fetch     → adapter.fetch(squadId, sourceId)     returns FetchedContent | null
 * normalize → IndexedDocumentWriter.normalize()    title, sensitivity, chunkMetadata, wikilinks
 * sourceId  → caller-provided string; adapter must accept whatever it returned from list()
 * upsert    → IndexedDocumentWriter.upsert()       document + chunk-diff + link rebuild
 * reconcile → adapter.reconcile()                  removes docs not in list()
 * remove    → adapter.remove(sourceId)             cascading delete
 */
export interface MemorySourceAdapter {
  readonly sourceType: string
  readonly capabilities: SourceCapabilities
  readonly defaultSensitivity: SensitivityTier

  list(squadId: string, opts?: { since?: string; [key: string]: unknown }): Promise<DiscoveredItem[]>
  fetch(squadId: string, sourceId: string): Promise<FetchedContent | null>
  index(squadId: string, sourceId: string): Promise<IndexResult>
  indexAll(squadId: string, opts?: { since?: string }): Promise<IndexResult[]>
  exists(squadId: string, sourceId: string): Promise<boolean>
  remove(squadId: string, sourceId: string): Promise<void>
  reconcile(squadId: string, opts?: { currentSourceIds?: string[] }): Promise<{ removed: number }>

  validatePolicy?(policy: unknown): string[] | null
  validateGrantFilter?(filter: unknown): string[] | null
  buildSearchSqlFilter?(filter: unknown): ReturnType<typeof sql> | null
}

export abstract class BaseMemorySourceAdapter implements MemorySourceAdapter {
  abstract readonly sourceType: string
  abstract readonly capabilities: SourceCapabilities
  abstract readonly defaultSensitivity: SensitivityTier

  abstract list(squadId: string, opts?: { since?: string; [key: string]: unknown }): Promise<DiscoveredItem[]>
  abstract fetch(squadId: string, sourceId: string): Promise<FetchedContent | null>
  abstract index(squadId: string, sourceId: string): Promise<IndexResult>
  abstract exists(squadId: string, sourceId: string): Promise<boolean>
  abstract remove(squadId: string, sourceId: string): Promise<void>

  async indexAll(squadId: string, opts?: { since?: string }): Promise<IndexResult[]> {
    const items = await this.list(squadId, opts)
    const out: IndexResult[] = []
    for (const item of items) out.push(await this.index(squadId, item.sourceId))
    return out
  }

  async reconcile(squadId: string, opts: { currentSourceIds?: string[] } = {}): Promise<{ removed: number }> {
    const live = new Set(opts.currentSourceIds ?? (await this.list(squadId)).map((item) => item.sourceId))
    const docs = await db
      .select({ id: memoryDocuments.id, sourceId: memoryDocuments.sourceId })
      .from(memoryDocuments)
      .where(and(eq(memoryDocuments.squadId, squadId), eq(memoryDocuments.sourceType, this.sourceType)))
    const stale = docs.filter((doc) => !live.has(doc.sourceId)).map((doc) => doc.id)
    if (stale.length > 0) await db.delete(memoryDocuments).where(inArray(memoryDocuments.id, stale))
    return { removed: stale.length }
  }
}
