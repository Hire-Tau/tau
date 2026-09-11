import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { db } from '../../../db'
import { memoryChunks, memoryDocuments, memoryLinks, squadSourceConfigs, squads } from '../../../db/schema'

let fileInfo: unknown = null
let apiError: Error | null = null
const getFileInfo = mock(async (_fileId: string) => {
  if (apiError) throw apiError
  return fileInfo
})

mock.module('../../../channels/slack', () => ({
  getSlackApi: () => ({ getFileInfo }),
  hasSlackBotToken: () => true,
}))

const { IndexingService } = await import('../indexer/IndexingService')
const { SlackCanvasSource } = await import('./SlackCanvasSource')

describe('SlackCanvasSource', () => {
  const testSquadId = crypto.randomUUID()
  const source = new SlackCanvasSource()

  beforeAll(async () => {
    await db.insert(squads).values({
      id: testSquadId,
      name: 'SlackCanvasSource Test Squad',
      purpose: 'Testing SlackCanvasSource',
      status: 'active',
    })
  })

  afterEach(async () => {
    fileInfo = null
    apiError = null
    getFileInfo.mockClear()
    await db.delete(memoryLinks).where(eq(memoryLinks.squadId, testSquadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(squadSourceConfigs).where(eq(squadSourceConfigs.squadId, testSquadId))
  })

  afterAll(async () => {
    await db.delete(squads).where(eq(squads.id, testSquadId))
  })

  it('indexes Slack canvas markdown using files.info without canvases.read', async () => {
    fileInfo = {
      id: 'F1',
      title: 'Huddle notes',
      subtype: 'huddle_notes',
      permalink: 'https://acme.slack.com/docs/F1',
      canvas: { document_content: { markdown: '# Notes\n\nTranscript summary' } },
    }

    const result = await source.index(testSquadId, 'C1:F1')

    expect(result.success).toBe(true)
    expect(getFileInfo).toHaveBeenCalledWith('F1')
    const [doc] = await db
      .select()
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, testSquadId),
          eq(memoryDocuments.sourceType, 'slack_canvas'),
          eq(memoryDocuments.sourceId, 'C1:F1')
        )
      )
    expect(doc.frontmatter).toMatchObject({
      kind: 'slack_canvas',
      canvasKind: 'huddle_notes',
      channelId: 'C1',
      fileId: 'F1',
      sourceLinks: ['https://acme.slack.com/docs/F1'],
    })
    const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, doc.id))
    expect(chunks[0].content).toContain('Transcript summary')
  })

  it('fails closed when slack_thread policy excludes the channel', async () => {
    await db.insert(squadSourceConfigs).values({
      squadId: testSquadId,
      sourceType: 'slack_thread',
      enabled: true,
      policy: { version: 1, scope: { channelIds: ['C2'] } },
    })

    const result = await source.index(testSquadId, 'C1:F1')

    expect(result).toMatchObject({ success: false, error: 'Slack channel not configured: C1' })
    expect(getFileInfo).not.toHaveBeenCalled()
  })

  it('skips inaccessible canvases without leaving a document', async () => {
    apiError = Object.assign(new Error('Slack API error: not_in_channel'), { code: 'not_in_channel' })

    const result = await source.index(testSquadId, 'C1:F1')

    expect(result).toMatchObject({ success: true, skipped: true, reason: 'no_access' })
    expect(await source.exists(testSquadId, 'C1:F1')).toBe(false)
  })

  it('skips canvases without markdown with a clear reason', async () => {
    fileInfo = {
      id: 'F1',
      title: 'Huddle notes',
      subtype: 'huddle_notes',
      permalink: 'https://acme.slack.com/docs/F1',
      canvas: { document_content: {} },
    }

    const result = await source.index(testSquadId, 'C1:F1')

    expect(result).toMatchObject({ success: true, skipped: true, reason: 'no_canvas' })
    expect(await source.exists(testSquadId, 'C1:F1')).toBe(false)
  })

  it('is registered with the indexing service', () => {
    const adapter = new IndexingService().getAdapter('slack_canvas')
    expect(adapter).toBeInstanceOf(SlackCanvasSource)
  })
})
