import { and, eq, sql } from 'drizzle-orm'
import { getSlackApi, hasSlackBotToken } from '../../../channels/slack'
import { db } from '../../../db'
import { memoryDocuments } from '../../../db/schema'
import { SquadSourceConfig } from '../../../entities/SquadSourceConfig'
import { createLogger } from '../../../lib/infra/logger'
import { BaseMemorySourceAdapter, sourceCapabilities, type DiscoveredItem, type FetchedContent } from './adapter'
import type { ContentChunk } from '../parser'
import { IndexedDocumentWriter } from './IndexedDocumentWriter'
import { mergePolicyErrors, validateBaseIngestionPolicy, validateStringArrayScope } from './policy'
import type { IndexResult } from './types'
import { IndexingService } from '../indexer/IndexingService'

const log = createLogger('slack-thread-source')
const PERMALINK_REGEX =
  /^https?:\/\/(?:[^/]+\.slack\.com|slack\.com)\/archives\/([A-Z0-9]+)\/p(\d+)(?:\?[^#]*thread_ts=([\d.]+))?/

export interface SlackThreadRef {
  channelId: string
  threadTs: string
}

export function parseSlackPermalink(url: string): SlackThreadRef | null {
  const match = PERMALINK_REGEX.exec(url)
  if (!match) return null
  const [, channelId, packedTs, queryThreadTs] = match
  if (!channelId || !packedTs) return null
  const threadTs = queryThreadTs ?? `${packedTs.slice(0, -6)}.${packedTs.slice(-6)}`
  return { channelId, threadTs }
}

export function slackThreadSourceId(ref: SlackThreadRef): string {
  return `${ref.channelId}:${ref.threadTs}`
}

function parseSourceId(sourceId: string): SlackThreadRef | null {
  const [channelId, threadTs, extra] = sourceId.split(':')
  if (!channelId || !threadTs || extra !== undefined) return null
  return { channelId, threadTs }
}

function slackPermalink(ref: SlackThreadRef): string {
  return `https://slack.com/archives/${ref.channelId}/p${ref.threadTs.replace('.', '')}`
}

function collectCanvasFileIds(messages: Array<{ files?: unknown[]; attachments?: unknown[] }>): string[] {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const file of message.files ?? []) {
      if (!file || typeof file !== 'object') continue
      const f = file as { id?: unknown; mimetype?: unknown; filetype?: unknown }
      if (typeof f.id === 'string' && (f.mimetype === 'application/vnd.slack-docs' || f.filetype === 'canvas')) {
        ids.add(f.id)
      }
    }
    for (const attachment of message.attachments ?? []) {
      if (!attachment || typeof attachment !== 'object') continue
      const fileId = (attachment as { file_id?: unknown }).file_id
      if (typeof fileId === 'string') ids.add(fileId)
    }
  }
  return [...ids]
}

function isHuddleThread(messages: Array<{ subtype?: string; room?: unknown }>): boolean {
  return messages.some((message) => {
    if (message.subtype === 'huddle_thread') return true
    const room = message.room
    return !!room && typeof room === 'object' && typeof (room as { huddle_id?: unknown }).huddle_id === 'string'
  })
}

function getPolicyStringArray(policy: Record<string, unknown> | null | undefined, key: string): string[] | null {
  const value =
    policy?.scope && typeof policy.scope === 'object' ? (policy.scope as Record<string, unknown>)[key] : undefined
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}

export class SlackThreadSource extends BaseMemorySourceAdapter {
  private static _instance: SlackThreadSource | null = null

  readonly sourceType = 'slack_thread'
  readonly capabilities = sourceCapabilities(['searchable', 'readable', 'incremental', 'external'])
  readonly defaultSensitivity = 'internal' as const

  static instance(): SlackThreadSource {
    if (!SlackThreadSource._instance) SlackThreadSource._instance = new SlackThreadSource()
    return SlackThreadSource._instance
  }

  static _reset(): void {
    SlackThreadSource._instance = null
  }

  async list(squadId: string): Promise<DiscoveredItem[]> {
    const config = await SquadSourceConfig.findBySquadAndType(squadId, this.sourceType)
    if (config?.enabled === false) return []

    const docs = await db
      .select({ sourceId: memoryDocuments.sourceId, updatedAt: memoryDocuments.updatedAt })
      .from(memoryDocuments)
      .where(and(eq(memoryDocuments.squadId, squadId), eq(memoryDocuments.sourceType, this.sourceType)))

    return docs.map((doc) => ({ sourceId: doc.sourceId, cursor: doc.updatedAt.toISOString() }))
  }

  async fetch(_squadId: string, sourceId: string): Promise<FetchedContent | null> {
    if (!hasSlackBotToken()) {
      log.warn('SLACK_BOT_TOKEN not set; cannot fetch slack thread')
      return null
    }

    const ref = parseSourceId(sourceId)
    if (!ref) return null

    const messages = await getSlackApi().getThreadReplies({ channel: ref.channelId, ts: ref.threadTs, limit: 200 })
    if (messages.length === 0) return null

    const canvasFileIds = collectCanvasFileIds(messages)
    const huddle = isHuddleThread(messages)
    const chunks: ContentChunk[] = []
    let nextStartLine = 1
    const lines = messages.map((message, index) => {
      const actor = message.user ?? message.bot_id ?? 'unknown'
      const content = `### ${actor} — ${message.ts}\n\n${message.text ?? ''}\n`
      const lineCount = content.split('\n').length
      chunks.push({
        index,
        content: content.trim(),
        startLine: nextStartLine,
        endLine: nextStartLine + lineCount - 1,
        metadata: {},
      })
      nextStartLine += lineCount + 1
      return content
    })

    return {
      content: lines.join('\n'),
      chunks,
      title: messages[0]?.text?.slice(0, 80) || `Slack thread ${sourceId}`,
      path: null,
      frontmatter: {
        kind: 'slack_thread',
        sourceLinks: [slackPermalink(ref)],
        channelId: ref.channelId,
        threadTs: ref.threadTs,
        rootUser: messages[0]?.user ?? messages[0]?.bot_id ?? null,
        messageCount: messages.length,
        relatedCanvases: canvasFileIds,
        huddle,
      },
      chunkMetadata: {
        sourceType: this.sourceType,
        parent: { ...ref, canvases: canvasFileIds },
      },
      chunkMetadataForChunk: (chunk) => {
        const match = chunk.content.match(/^### (\S+) — ([\d.]+)/m)
        return match ? { event: { actor: match[1], ts: match[2] } } : {}
      },
    }
  }

  async index(squadId: string, sourceId: string): Promise<IndexResult> {
    const config = await SquadSourceConfig.findBySquadAndType(squadId, this.sourceType)
    if (config?.enabled === false) return { success: true, chunksCreated: 0, linksCreated: 0, skipped: true }

    const ref = parseSourceId(sourceId)
    if (!ref)
      return { success: false, chunksCreated: 0, linksCreated: 0, error: `Invalid Slack thread source id: ${sourceId}` }

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

    const fetched = await this.fetch(squadId, sourceId)
    if (!fetched) {
      await this.remove(squadId, sourceId)
      return { success: true, chunksCreated: 0, linksCreated: 0, skipped: true }
    }

    const result = await IndexedDocumentWriter.instance().writeDocument({
      squadId,
      sourceType: this.sourceType,
      sourceId,
      fetched,
      adapterDefaultSensitivity: this.defaultSensitivity,
      policy: config?.policy,
      chunker: 'markdown',
    })

    if (result.success) {
      const canvasFileIds = Array.isArray(fetched.frontmatter?.relatedCanvases)
        ? fetched.frontmatter.relatedCanvases.filter((id): id is string => typeof id === 'string')
        : []
      for (const fileId of canvasFileIds) {
        try {
          const canvasResult = await IndexingService.instance().index(
            squadId,
            'slack_canvas',
            `${ref.channelId}:${fileId}`
          )
          if (!canvasResult.success) {
            log.warn(
              `Slack canvas fan-out failed for ${fileId} from thread ${sourceId}: ${canvasResult.error ?? 'unknown error'}`
            )
          }
        } catch (error) {
          log.warn(`Failed to index Slack canvas ${fileId} from thread ${sourceId}: ${error}`)
        }
      }
    }

    return result
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
