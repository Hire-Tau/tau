import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { db, squads } from '../../../db'
import { SquadSourceConfig } from '../../../entities/SquadSourceConfig'
import { sourceCapabilities, type MemorySourceAdapter } from '../sources/adapter'
import type { IndexResult } from '../sources/types'
import { ExternalSourceReindexService } from './ExternalSourceReindexService'
import { IndexingService } from './IndexingService'

function adapter(sourceType: string, results: IndexResult[] | (() => Promise<IndexResult[]>)): MemorySourceAdapter {
  return {
    sourceType,
    capabilities: sourceCapabilities(['searchable', 'external']),
    defaultSensitivity: 'internal',
    async list() {
      return []
    },
    async fetch() {
      return null
    },
    async index() {
      return { success: true, chunksCreated: 1, linksCreated: 0 }
    },
    async indexAll() {
      return typeof results === 'function' ? results() : results
    },
    async exists() {
      return true
    },
    async remove() {},
    async reconcile() {
      return { removed: 0 }
    },
  }
}

describe('ExternalSourceReindexService', () => {
  const squadId = crypto.randomUUID()

  beforeAll(async () => {
    await db.insert(squads).values({ id: squadId, name: 'External Reindex Test', purpose: 'test', status: 'active' })
  })

  beforeEach(() => {
    IndexingService._reset()
    ExternalSourceReindexService._reset()
  })

  it('aggregates enabled source index results', async () => {
    const indexing = IndexingService.instance()
    indexing.registerAdapter(
      adapter('slack_thread', [
        { success: true, chunksCreated: 1, linksCreated: 0 },
        { success: false, chunksCreated: 0, linksCreated: 0, error: 'boom' },
        { success: true, skipped: true, chunksCreated: 0, linksCreated: 0 },
      ])
    )

    const report = await ExternalSourceReindexService.instance().reindexSquad(squadId, {
      sourceTypes: ['slack_thread'],
    })

    expect(report.slack_thread).toMatchObject({ indexed: 1, skipped: 1, failed: 1, disabled: false })
    expect(report.slack_thread?.errors).toEqual(['boom'])
  })

  it('skips disabled source configs', async () => {
    await SquadSourceConfig.upsert({ squadId, sourceType: 'slack_canvas', enabled: false, policy: {} })

    const report = await ExternalSourceReindexService.instance().reindexSquad(squadId, {
      sourceTypes: ['slack_canvas'],
    })

    expect(report.slack_canvas).toMatchObject({ indexed: 0, skipped: 1, failed: 0, disabled: true })
  })

  it('records thrown adapter errors without aborting other sources', async () => {
    const indexing = IndexingService.instance()
    indexing.registerAdapter(
      adapter('slack_thread', async () => {
        throw new Error('slack failed')
      })
    )
    indexing.registerAdapter(adapter('github_issue', [{ success: true, chunksCreated: 1, linksCreated: 0 }]))

    const report = await ExternalSourceReindexService.instance().reindexSquad(squadId, {
      sourceTypes: ['slack_thread', 'github_issue'],
    })

    expect(report.slack_thread).toMatchObject({ failed: 1, errors: ['slack failed'] })
    expect(report.github_issue).toMatchObject({ indexed: 1, failed: 0 })
  })
})
