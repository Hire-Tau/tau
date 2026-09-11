import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { db } from '../../../db'
import { memoryChunks, memoryDocuments, memoryLinks, squads } from '../../../db/schema'

let replies: Array<{
  ts: string
  text: string
  user?: string
  subtype?: string
  room?: unknown
  files?: unknown[]
  attachments?: unknown[]
}> = []

mock.module('../../../channels/slack', () => ({
  getSlackApi: () => ({
    getThreadReplies: mock(async () => replies),
  }),
  hasSlackBotToken: () => true,
}))

const { IndexingService } = await import('../indexer/IndexingService')
const { SlackThreadSource, parseSlackPermalink, slackThreadSourceId } = await import('./SlackThreadSource')

describe('parseSlackPermalink', () => {
  it('parses a thread reply permalink', () => {
    const url = 'https://acme.slack.com/archives/C0123ABCDE/p1715800000123456?thread_ts=1715800000.123456'
    expect(parseSlackPermalink(url)).toEqual({ channelId: 'C0123ABCDE', threadTs: '1715800000.123456' })
  })

  it('parses a top-of-thread permalink (no thread_ts query)', () => {
    const url = 'https://acme.slack.com/archives/C0123ABCDE/p1715800000123456'
    expect(parseSlackPermalink(url)).toEqual({ channelId: 'C0123ABCDE', threadTs: '1715800000.123456' })
  })

  it('parses the canonical slack.com archive permalink host', () => {
    const url = 'https://slack.com/archives/C0B3U3X19E2/p1779405248857339'
    expect(parseSlackPermalink(url)).toEqual({ channelId: 'C0B3U3X19E2', threadTs: '1779405248.857339' })
  })

  it('returns null for non-Slack URLs', () => {
    expect(parseSlackPermalink('https://example.com/foo')).toBeNull()
  })
})

describe('slackThreadSourceId', () => {
  it('builds a stable channel:ts source id', () => {
    expect(slackThreadSourceId({ channelId: 'C1', threadTs: '1.2' })).toBe('C1:1.2')
  })
})

describe('SlackThreadSource', () => {
  const testSquadId = crypto.randomUUID()
  const source = new SlackThreadSource()

  beforeAll(async () => {
    await db.insert(squads).values({
      id: testSquadId,
      name: 'SlackThreadSource Test Squad',
      purpose: 'Testing SlackThreadSource',
      status: 'active',
    })
  })

  afterEach(async () => {
    replies = []
    await db.delete(memoryLinks).where(eq(memoryLinks.squadId, testSquadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
  })

  afterAll(async () => {
    await db.delete(squads).where(eq(squads.id, testSquadId))
  })

  it('indexes each Slack thread as one document with message event chunks', async () => {
    replies = [
      { ts: '1.200000', user: 'U1', text: 'Root message' },
      { ts: '1.300000', user: 'U2', text: '## Reply heading\n\nReply message' },
    ]

    const result = await source.index(testSquadId, 'C1:1.2')

    expect(result.success).toBe(true)
    expect(result.chunksCreated).toBe(2)

    const [doc] = await db
      .select()
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, testSquadId),
          eq(memoryDocuments.sourceType, 'slack_thread'),
          eq(memoryDocuments.sourceId, 'C1:1.2')
        )
      )
    expect(doc.frontmatter).toMatchObject({ kind: 'slack_thread', channelId: 'C1', threadTs: '1.2', messageCount: 2 })

    const chunks = await db
      .select()
      .from(memoryChunks)
      .where(eq(memoryChunks.documentId, doc.id))
      .orderBy(memoryChunks.chunkIndex)
    expect(chunks).toHaveLength(replies.length)
    expect(chunks.map((chunk) => (chunk.metadata as any).event.actor)).toEqual(['U1', 'U2'])
    expect(chunks.map((chunk) => (chunk.metadata as any).event.ts)).toEqual(['1.200000', '1.300000'])
  })

  it('keeps one chunk per Slack message even when message text is long', async () => {
    replies = [
      { ts: '1.200000', user: 'U1', text: 'Root message' },
      { ts: '1.300000', user: 'U2', text: `${'long text '.repeat(350)}\n\n## heading inside long message` },
    ]

    const result = await source.index(testSquadId, 'C1:1.2')

    expect(result.success).toBe(true)
    expect(result.chunksCreated).toBe(2)

    const chunks = await db
      .select()
      .from(memoryChunks)
      .where(eq(memoryChunks.documentId, result.documentId!))
      .orderBy(memoryChunks.chunkIndex)
    expect(chunks).toHaveLength(replies.length)
    expect(chunks.map((chunk) => (chunk.metadata as any).event.actor)).toEqual(['U1', 'U2'])
    expect(chunks[1].content).toContain('heading inside long message')
  })

  it('skips unchanged thread content and removes missing threads', async () => {
    replies = [{ ts: '1.200000', user: 'U1', text: 'Root message' }]
    const first = await source.index(testSquadId, 'C1:1.2')
    expect(first.success).toBe(true)

    const second = await source.index(testSquadId, 'C1:1.2')
    expect(second).toMatchObject({ success: true, skipped: true, chunksCreated: 0 })

    replies = []
    const removed = await source.index(testSquadId, 'C1:1.2')
    expect(removed).toMatchObject({ success: true, skipped: true, chunksCreated: 0 })
    expect(await source.exists(testSquadId, 'C1:1.2')).toBe(false)
  })

  it('records huddle canvas references and fans out canvas indexing', async () => {
    replies = [
      {
        ts: '1.200000',
        user: 'U1',
        text: 'Huddle started',
        subtype: 'huddle_thread',
        room: { id: 'R1', huddle_id: 'H1' },
        files: [{ id: 'F1', mimetype: 'application/vnd.slack-docs', filetype: 'canvas' }],
      },
    ]
    const indexSpy = mock(async (_squadId: string, _sourceType: string, _sourceId: string) => ({
      success: false,
      chunksCreated: 0,
      linksCreated: 0,
      error: 'Slack channel excluded: C1',
    }))
    const warnSpy = mock(() => {})
    const originalWarn = console.warn
    console.warn = warnSpy as unknown as typeof console.warn
    const originalInstance = IndexingService.instance
    ;(IndexingService as any).instance = () => ({ index: indexSpy })
    try {
      const result = await source.index(testSquadId, 'C1:1.2')
      expect(result.success).toBe(true)
      expect(indexSpy).toHaveBeenCalledWith(testSquadId, 'slack_canvas', 'C1:F1')
      expect(warnSpy).toHaveBeenCalledWith(
        '[slack-thread-source]',
        expect.stringContaining('Slack canvas fan-out failed')
      )
    } finally {
      ;(IndexingService as any).instance = originalInstance
      console.warn = originalWarn
    }

    const [doc] = await db
      .select()
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, testSquadId),
          eq(memoryDocuments.sourceType, 'slack_thread'),
          eq(memoryDocuments.sourceId, 'C1:1.2')
        )
      )
    expect(doc.frontmatter).toMatchObject({ relatedCanvases: ['F1'], huddle: true })
  })

  it('is registered with the indexing service', () => {
    const adapter = new IndexingService().getAdapter('slack_thread')
    expect(adapter).toBeInstanceOf(SlackThreadSource)
  })

  it('validates Slack-specific policy and grant filters', () => {
    expect(source.validatePolicy({ version: 1, scope: { channelIds: ['C1'], excludeChannelIds: ['C2'] } })).toBeNull()
    expect(source.validatePolicy({ version: 1, scope: { channelIds: 'C1' } })).toEqual([
      'scope.channelIds must be an array of strings',
    ])
    expect(source.validateGrantFilter({ channelIds: ['C1'] })).toBeNull()
    expect(source.validateGrantFilter({ channelIds: 'C1' })).toEqual(['channelIds must be a string array'])
  })
})
