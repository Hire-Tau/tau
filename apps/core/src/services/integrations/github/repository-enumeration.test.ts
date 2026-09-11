import { describe, expect, test } from 'bun:test'
import { createEventPollingBudget } from '../event-polling-budget'
import {
  GitHubRepositoryExpander,
  isRepositoryPattern,
  type RepositoryExpansionWarning,
} from './repository-enumeration'

type Page = { status?: number; body?: unknown; etag?: string; next?: boolean }

/** A fake GitHub that serves /user/repos pages and records every request. */
function fakeGitHub(pages: Record<string, Page | (() => Page)>) {
  const requests: { url: string; headers: Record<string, string> }[] = []
  const fetch = async (input: string, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    )
    requests.push({ url: input, headers })
    const url = new URL(input)
    const key = `${url.pathname}?page=${url.searchParams.get('page') ?? '1'}`
    const entry = pages[key]
    const page = typeof entry === 'function' ? entry() : entry
    if (!page) return new Response('not found', { status: 404 })
    if (page.etag && headers['if-none-match'] === page.etag) return new Response(null, { status: 304 })
    const responseHeaders: Record<string, string> = { 'content-type': 'application/json' }
    if (page.etag) responseHeaders.etag = page.etag
    if (page.next)
      responseHeaders.link = `<${url.origin}${url.pathname}?page=${Number(url.searchParams.get('page') ?? '1') + 1}>; rel="next"`
    return new Response(JSON.stringify(page.body ?? []), { status: page.status ?? 200, headers: responseHeaders })
  }
  return { fetch, requests }
}

const repos = (...names: string[]) => names.map((full_name) => ({ full_name }))

function makeExpander(
  github: ReturnType<typeof fakeGitHub>,
  overrides: Partial<ConstructorParameters<typeof GitHubRepositoryExpander>[0]> = {}
) {
  const warnings: RepositoryExpansionWarning[] = []
  let now = 1_000_000
  const expander = new GitHubRepositoryExpander({
    fetch: github.fetch,
    apiBase: 'https://api.github.test',
    resolveCredential: async (connectionId) =>
      connectionId === 'c1' ? { revision: 'rev-1', accessToken: 'token-1' } : undefined,
    now: () => now,
    onWarning: (warning) => warnings.push(warning),
    ...overrides,
  })
  return { expander, warnings, advance: (ms: number) => (now += ms) }
}

describe('isRepositoryPattern', () => {
  test('only a * makes a pattern; exact keys are not patterns', () => {
    expect(isRepositoryPattern('acme/*')).toBe(true)
    expect(isRepositoryPattern('acme/svc-*')).toBe(true)
    expect(isRepositoryPattern('acme/widgets')).toBe(false)
  })
})

describe('GitHubRepositoryExpander', () => {
  test('passes exact repositories through lowercased without calling GitHub', async () => {
    const github = fakeGitHub({})
    const { expander } = makeExpander(github)
    expect(await expander.expand('c1', ['Acme/Widgets', 'acme/widgets'])).toEqual(['acme/widgets'])
    expect(github.requests).toHaveLength(0)
  })

  test('expands a wildcard against the repositories visible to the connection, across pages', async () => {
    const github = fakeGitHub({
      '/user/repos?page=1': { body: repos('Acme/Widgets', 'acme/gadgets', 'other/thing'), etag: '"v1"', next: true },
      '/user/repos?page=2': { body: repos('acme/svc-api', 'acme/svc-web') },
    })
    const { expander } = makeExpander(github)
    expect(await expander.expand('c1', ['acme/*'])).toEqual([
      'acme/gadgets',
      'acme/svc-api',
      'acme/svc-web',
      'acme/widgets',
    ])
    expect(await expander.expand('c1', ['acme/svc-*', 'acme/widgets'])).toEqual([
      'acme/svc-api',
      'acme/svc-web',
      'acme/widgets',
    ])
    // One listing served both calls; the request is authenticated and paginated.
    expect(github.requests.map((r) => r.url)).toEqual([
      'https://api.github.test/user/repos?per_page=100&affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name&page=1',
      'https://api.github.test/user/repos?per_page=100&affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name&page=2',
    ])
    expect(github.requests[0]!.headers.authorization).toBe('Bearer token-1')
    expect(github.requests[0]!.headers.accept).toBe('application/vnd.github+json')
  })

  test('overlapping patterns and exact names dedupe into one sorted set', async () => {
    const github = fakeGitHub({ '/user/repos?page=1': { body: repos('acme/a', 'acme/b') } })
    const { expander } = makeExpander(github)
    expect(await expander.expand('c1', ['acme/*', 'acme/a*', 'ACME/B'])).toEqual(['acme/a', 'acme/b'])
  })

  test('refreshes after the TTL with a conditional request and keeps the list on 304', async () => {
    let served = 0
    const github = fakeGitHub({
      '/user/repos?page=1': () => {
        served++
        return { body: repos('acme/a'), etag: '"v1"' }
      },
    })
    const { expander, advance } = makeExpander(github, { ttlMs: 60_000 })
    await expander.expand('c1', ['acme/*'])
    await expander.expand('c1', ['acme/*'])
    expect(github.requests).toHaveLength(1)
    advance(60_001)
    expect(await expander.expand('c1', ['acme/*'])).toEqual(['acme/a'])
    expect(github.requests).toHaveLength(2)
    expect(github.requests[1]!.headers['if-none-match']).toBe('"v1"')
    // The fake answered 304 for the matching ETag; the cached list still served.
    expect(served).toBe(2)
  })

  test('a connection revision change (re-auth) discards the cached listing', async () => {
    let revision = 'rev-1'
    const github = fakeGitHub({
      '/user/repos?page=1': () => ({ body: repos(revision === 'rev-1' ? 'acme/old' : 'acme/new') }),
    })
    const { expander } = makeExpander(github, {
      resolveCredential: async () => ({ revision, accessToken: 't' }),
    })
    expect(await expander.expand('c1', ['acme/*'])).toEqual(['acme/old'])
    revision = 'rev-2'
    expect(await expander.expand('c1', ['acme/*'])).toEqual(['acme/new'])
  })

  test('revoked access (401) drops the listing, so patterns contribute nothing and a warning is raised', async () => {
    let revoked = false
    const github = fakeGitHub({
      '/user/repos?page=1': () =>
        revoked ? { status: 401, body: { message: 'Bad credentials' } } : { body: repos('acme/a') },
    })
    const { expander, warnings, advance } = makeExpander(github, { ttlMs: 1000 })
    expect(await expander.expand('c1', ['acme/*', 'acme/exact'])).toEqual(['acme/a', 'acme/exact'])
    revoked = true
    advance(1001)
    expect(await expander.expand('c1', ['acme/*', 'acme/exact'])).toEqual(['acme/exact'])
    expect(warnings).toEqual([
      expect.objectContaining({ connectionId: 'c1', pattern: 'acme/*', code: 'enumeration_failed' }),
    ])
  })

  test('a transient failure keeps serving the last known listing', async () => {
    let failing = false
    const github = fakeGitHub({
      '/user/repos?page=1': () => (failing ? { status: 502, body: {} } : { body: repos('acme/a') }),
    })
    const { expander, warnings, advance } = makeExpander(github, { ttlMs: 1000 })
    await expander.expand('c1', ['acme/*'])
    failing = true
    advance(1001)
    expect(await expander.expand('c1', ['acme/*'])).toEqual(['acme/a'])
    expect(warnings).toEqual([])
  })

  test('a pattern matching more repositories than the cap contributes nothing, with a warning', async () => {
    const github = fakeGitHub({ '/user/repos?page=1': { body: repos('acme/a', 'acme/b', 'acme/c') } })
    const { expander, warnings } = makeExpander(github, { maxRepositoriesPerPattern: 2 })
    expect(await expander.expand('c1', ['acme/*', 'acme/a'])).toEqual(['acme/a'])
    expect(warnings).toEqual([
      expect.objectContaining({
        connectionId: 'c1',
        pattern: 'acme/*',
        code: 'too_many_matches',
        matched: 3,
        limit: 2,
      }),
    ])
  })

  test('no usable credential and no cache means patterns contribute nothing, with a warning', async () => {
    const github = fakeGitHub({ '/user/repos?page=1': { body: repos('acme/a') } })
    const { expander, warnings } = makeExpander(github)
    expect(await expander.expand('c2', ['acme/*', 'acme/exact'])).toEqual(['acme/exact'])
    expect(github.requests).toHaveLength(0)
    expect(warnings).toEqual([expect.objectContaining({ connectionId: 'c2', code: 'credential_unavailable' })])
  })

  test('listing requests draw from the polling budget and stop when it is exhausted', async () => {
    const github = fakeGitHub({
      '/user/repos?page=1': { body: repos('acme/a'), next: true },
      '/user/repos?page=2': { body: repos('acme/b') },
    })
    const { expander, warnings } = makeExpander(github)
    const budget = createEventPollingBudget(1)
    expect(await expander.expand('c1', ['acme/*'], budget.signal)).toEqual([])
    expect(github.requests).toHaveLength(1)
    expect(budget.remaining).toBe(0)
    expect(warnings).toEqual([expect.objectContaining({ code: 'enumeration_failed' })])
  })
})
