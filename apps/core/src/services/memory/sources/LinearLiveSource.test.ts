import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { resetSecretStore } from '../../secrets'
import { IndexingService } from '../indexer/IndexingService'
import { SearchService } from '../SearchService'
import { LiveRateLimiter } from './live-rate-limiter'
import { LinearLiveSource } from './LinearLiveSource'

const originalFetch = globalThis.fetch
let credential: string | undefined = 'fake'
const source = new LinearLiveSource(async () => credential)

const linearResponse = {
  data: {
    issueSearch: {
      nodes: [
        {
          id: 'lin_1',
          identifier: 'ENG-42',
          title: 'Fix login flow',
          description: 'Users see a blank screen when logging in',
          url: 'https://linear.app/acme/issue/ENG-42',
          state: { name: 'Backlog' },
          team: { key: 'ENG' },
          assignee: { displayName: 'alice' },
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      ],
    },
  },
}

const fetchInits: RequestInit[] = []
const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
  if (init) fetchInits.push(init)
  return new Response(JSON.stringify(linearResponse), { headers: { 'content-type': 'application/json' } })
})

beforeEach(() => {
  LinearLiveSource._reset()
  IndexingService._reset()
  SearchService._reset()
  resetSecretStore()
  credential = 'fake'
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  fetchMock.mockClear()
  fetchInits.length = 0
  resetSecretStore()
  globalThis.fetch = originalFetch
})

describe('LinearLiveSource', () => {
  it('returns live search results with provenance', async () => {
    const out = await source.search('login', {
      scopes: [{ squadId: 'sq1', isOwn: true, filters: {} }],
      callerSquadId: 'sq1',
      deadlineMs: 2000,
    })

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      sourceType: 'linear_issue',
      sourceSquadId: 'sq1',
      sourceId: 'lin_1',
      title: 'ENG-42 — Fix login flow',
      snippet: 'Users see a blank screen when logging in',
      sensitivity: 'internal',
      provenance: { url: 'https://linear.app/acme/issue/ENG-42', teamKey: 'ENG', state: 'Backlog', assignee: 'alice' },
      event: { ts: '2026-05-01T00:00:00.000Z' },
    })
  })

  it('adds grant teamKeys to the Linear query and validates malformed filters', async () => {
    expect(LinearLiveSource.instance().validateGrantFilter({ teamKeys: ['ENG'] })).toBeNull()
    expect(LinearLiveSource.instance().validateGrantFilter({ teamKeys: 'ENG' })).toEqual([
      'teamKeys must be a string array',
    ])

    await source.search('login', {
      scopes: [
        {
          squadId: 'sq-source',
          isOwn: false,
          filters: { sourceFilters: { linear_issue: { teamKeys: ['ENG', 'OPS'] } } },
        },
      ],
      callerSquadId: 'sq-caller',
      deadlineMs: 2000,
    })

    const body = JSON.parse(fetchInits[0].body as string)
    expect(body.variables.query).toBe('login team:ENG,OPS')
  })

  it('returns [] when LINEAR_API_KEY is missing', async () => {
    credential = undefined

    await expect(
      source.search('login', {
        scopes: [{ squadId: 'sq1', isOwn: true, filters: {} }],
        callerSquadId: 'sq1',
        deadlineMs: 2000,
      })
    ).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is registered as a live adapter by default', () => {
    expect(IndexingService.instance().getLiveAdapter('linear_issue')).toBe(LinearLiveSource.instance())
  })

  it('SearchService surfaces Linear timeout and rate-limit live errors', async () => {
    const squadId = randomUUID()
    const registry = IndexingService.instance()
    const adapter = LinearLiveSource.instance()
    registry.registerLiveAdapter({
      ...adapter,
      timeoutMs: 1,
      search: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return []
      },
    })

    const service = new SearchService({ liveRateLimiter: new LiveRateLimiter() })
    const timeout = await service.search(squadId, 'login', { sourceTypes: ['linear_issue'], mode: 'keyword' })
    expect(timeout[0]?.provenance).toEqual({ error: 'timeout' })

    registry.registerLiveAdapter({
      ...adapter,
      timeoutMs: 100,
      rateLimit: { perMinute: 0 },
      search: async () => [],
    })
    const rateLimited = await service.search(squadId, 'login', { sourceTypes: ['linear_issue'], mode: 'keyword' })
    expect(rateLimited[0]?.provenance).toEqual({ error: 'rate_limited' })
  })
})
