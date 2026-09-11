import { and, eq, sql } from 'drizzle-orm'
import { getSlackApi, hasSlackBotToken } from '../../../channels/slack'
import { db } from '../../../db'
import { memoryDocuments } from '../../../db/schema'
import { SquadSourceConfig } from '../../../entities/SquadSourceConfig'
import { createLogger } from '../../../lib/infra/logger'
import { BaseMemorySourceAdapter, sourceCapabilities, type DiscoveredItem, type FetchedContent } from './adapter'
import { IndexedDocumentWriter } from './IndexedDocumentWriter'
import { mergePolicyErrors, validateBaseIngestionPolicy, validateStringArrayScope } from './policy'
import type { IndexResult } from './types'

const log = createLogger('slack-canvas-source')

type SlackCanvasSkipReason = 'missing_token' | 'invalid_source_id' | 'no_access' | 'no_canvas'

interface SlackCanvasRef {
  channelId: string
  fileId: string
}

interface SlackCanvasFetchResult {
  fetched: FetchedContent | null
  reason?: SlackCanvasSkipReason
}

function parseSourceId(sourceId: string): SlackCanvasRef | null {
  const [channelId, fileId, extra] = sourceId.split(':')
  if (!channelId || !fileId || extra !== undefined) return null
  return { channelId, fileId }
}

function getPolicyStringArray(policy: Record<string, unknown> | null | undefined, key: string): string[] | null {
  const value =
    policy?.scope && typeof policy.scope === 'object' ? (policy.scope as Record<string, unknown>)[key] : undefined
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}

function isNoAccessError(error: unknown): boolean {
  const code = typeof error === 'object' && error ? (error as { code?: unknown }).code : undefined
  const message = error instanceof Error ? error.message : String(error)
  return code === 'not_in_channel' || code === 'access_denied' || /not_in_channel|access_denied/.test(message)
}

function canvasKind(file: { subtype?: string; title?: string }): 'huddle_notes' | 'canvas' {
  const text = `${file.subtype ?? ''} ${file.title ?? ''}`.toLowerCase()
  return text.includes('huddle') ? 'huddle_notes' : 'canvas'
}

export class SlackCanvasSource extends BaseMemorySourceAdapter {
  private static _instance: SlackCanvasSource | null = null

  readonly sourceType = 'slack_canvas'
  readonly capabilities = sourceCapabilities(['searchable', 'readable', 'incremental', 'external'])
  readonly defaultSensitivity = 'internal' as const

  static instance(): SlackCanvasSource {
    if (!SlackCanvasSource._instance) SlackCanvasSource._instance = new SlackCanvasSource()
    return SlackCanvasSource._instance
  }

  static _reset(): void {
    SlackCanvasSource._instance = null
  }

  async list(squadId: string): Promise<DiscoveredItem[]> {
    const docs = await db
      .select({ sourceId: memoryDocuments.sourceId, updatedAt: memoryDocuments.updatedAt })
      .from(memoryDocuments)
      .where(and(eq(memoryDocuments.squadId, squadId), eq(memoryDocuments.sourceType, this.sourceType)))
    return docs.map((doc) => ({ sourceId: doc.sourceId, cursor: doc.updatedAt.toISOString() }))
  }

  async fetch(_squadId: string, sourceId: string): Promise<FetchedContent | null> {
    return (await this.fetchWithReason(sourceId)).fetched
  }

  private async fetchWithReason(sourceId: string): Promise<SlackCanvasFetchResult> {
    if (!hasSlackBotToken()) {
      log.warn('SLACK_BOT_TOKEN not set; cannot fetch slack canvas')
      return { fetched: null, reason: 'missing_token' }
    }

    const ref = parseSourceId(sourceId)
    if (!ref) return { fetched: null, reason: 'invalid_source_id' }

    try {
      // Slack exposes huddle notes Canvas content through files.info. There is no
      // public huddle-transcript endpoint and no canvases.read method for full content.
      const file = await getSlackApi().getFileInfo(ref.fileId)
      const markdown = file.canvas?.document_content?.markdown?.trim()
      if (!markdown) return { fetched: null, reason: 'no_canvas' }

      return {
        fetched: {
          content: markdown,
          title: file.title || `Slack canvas ${ref.fileId}`,
          path: null,
          frontmatter: {
            kind: 'slack_canvas',
            canvasKind: canvasKind(file),
            channelId: ref.channelId,
            fileId: ref.fileId,
            title: file.title ?? null,
            sourceLinks: file.permalink ? [file.permalink] : [],
          },
          chunkMetadata: {
            sourceType: this.sourceType,
            parent: ref,
          },
        },
      }
    } catch (error) {
      if (isNoAccessError(error)) {
        log.warn(`No access to Slack canvas ${ref.fileId} in ${ref.channelId}: ${error}`)
        return { fetched: null, reason: 'no_access' }
      }
      throw error
    }
  }

  async index(squadId: string, sourceId: string): Promise<IndexResult> {
    const ref = parseSourceId(sourceId)
    if (!ref)
      return { success: false, chunksCreated: 0, linksCreated: 0, error: `Invalid Slack canvas source id: ${sourceId}` }

    const config = await SquadSourceConfig.findBySquadAndType(squadId, 'slack_thread')
    if (config?.enabled === false) return { success: true, chunksCreated: 0, linksCreated: 0, skipped: true }

    const allowedChannelIds = getPolicyStringArray(config?.policy, 'channelIds')
    if (allowedChannelIds && !allowedChannelIds.includes(ref.channelId)) {
      return {
        success: false,
        chunksCreated: 0,
        linksCreated: 0,
        error: `Slack channel not configured: ${ref.channelId}`,
      }
    }

    const excludedChannelIds = getPolicyStringArray(config?.policy, 'excludeChannelIds') ?? []
    if (excludedChannelIds.includes(ref.channelId)) {
      return { success: false, chunksCreated: 0, linksCreated: 0, error: `Slack channel excluded: ${ref.channelId}` }
    }

    const { fetched, reason } = await this.fetchWithReason(sourceId)
    if (!fetched) {
      await this.remove(squadId, sourceId)
      return { success: true, chunksCreated: 0, linksCreated: 0, skipped: true, reason }
    }

    return IndexedDocumentWriter.instance().writeDocument({
      squadId,
      sourceType: this.sourceType,
      sourceId,
      fetched,
      adapterDefaultSensitivity: this.defaultSensitivity,
      policy: config?.policy,
      chunker: 'markdown',
    })
  }

  async exists(squadId: string, sourceId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: memoryDocuments.id })
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          eq(memoryDocuments.sourceType, this.sourceType),
          eq(memoryDocuments.sourceId, sourceId)
        )
      )
      .limit(1)
    return !!row
  }

  async remove(squadId: string, sourceId: string): Promise<void> {
    await db
      .delete(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          eq(memoryDocuments.sourceType, this.sourceType),
          eq(memoryDocuments.sourceId, sourceId)
        )
      )
  }

  validatePolicy(policy: unknown): string[] | null {
    return mergePolicyErrors(
      validateBaseIngestionPolicy(policy),
      validateStringArrayScope(policy, 'channelIds'),
      validateStringArrayScope(policy, 'excludeChannelIds')
    )
  }

  validateGrantFilter(filter: unknown): string[] | null {
    if (filter === undefined || filter === null) return null
    if (typeof filter !== 'object' || Array.isArray(filter)) return ['filter must be an object']
    const channelIds = (filter as Record<string, unknown>).channelIds
    if (
      channelIds !== undefined &&
      (!Array.isArray(channelIds) || channelIds.some((value) => typeof value !== 'string'))
    ) {
      return ['channelIds must be a string array']
    }
    return null
  }

  buildSearchSqlFilter(filter: unknown): ReturnType<typeof sql> | null {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null
    const channelIds = (filter as Record<string, unknown>).channelIds
    if (!Array.isArray(channelIds) || channelIds.length === 0) return null
    return sql`${memoryDocuments.frontmatter}->>'channelId' = ANY(array[${sql.join(
      channelIds.map((channelId) => sql`${channelId}`),
      sql`, `
    )}])`
  }
}
