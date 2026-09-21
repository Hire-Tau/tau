import { expect, test } from 'bun:test'
import { checkGitHubRepositoryAccess } from './repository-access'

const installation = (login = 'example', id = 1) => ({
  id,
  account: { login },
  permissions: { contents: 'write', workflows: 'write' },
  suspended_at: null as string | null,
})
function fixture(items = [installation()], count = items.length, repositoryCount = 2) {
  const calls: string[] = []
  const fetcher = async (input: string, init?: RequestInit) => {
    calls.push(String(input))
    expect(init?.redirect).toBe('error')
    expect(init?.signal).toBeDefined()
    return Response.json(
      String(input).includes('/repositories?')
        ? { total_count: repositoryCount }
        : { total_count: count, installations: items }
    )
  }
  return { calls, fetcher }
}

test('account authorization without any installations requires repository access', async () => {
  const { fetcher, calls } = fixture([])
  expect(await checkGitHubRepositoryAccess('secret', 'example', fetcher)).toEqual({
    status: 'missing',
    personalAccountInstalled: false,
    complete: true,
    installations: [],
  })
  expect(calls).toHaveLength(1)
})

test('organization access does not imply installation on the user account', async () => {
  const { fetcher } = fixture([installation('org')])
  const result = await checkGitHubRepositoryAccess('secret', 'example', fetcher)
  expect(result.status).toBe('verified')
  expect(result.personalAccountInstalled).toBe(false)
  expect(result.installations[0]).toEqual({
    account: 'org',
    repositoryCount: 2,
    contentsWrite: true,
    workflowsWrite: true,
    suspended: false,
  })
  expect(JSON.stringify(result)).not.toContain('secret')
})

test('personal installation verifies accessible repositories and reports missing write permission', async () => {
  const item = installation('EXAMPLE')
  item.permissions.workflows = 'read'
  const { fetcher } = fixture([item])
  const result = await checkGitHubRepositoryAccess('secret', 'example', fetcher)
  expect(result.personalAccountInstalled).toBe(true)
  expect(result.status).toBe('verified')
  expect(result.installations[0]?.workflowsWrite).toBe(false)
})

test('an installation with no accessible repositories is not ready', async () => {
  const { fetcher } = fixture([installation()], 1, 0)
  expect((await checkGitHubRepositoryAccess('secret', 'example', fetcher)).status).toBe('missing')
})

test('a suspended installation grants no usable access', async () => {
  const { calls, fetcher } = fixture([{ ...installation(), suspended_at: '2026-09-01' }])
  const result = await checkGitHubRepositoryAccess('secret', 'example', fetcher)
  expect(result.status).toBe('missing')
  expect(result.installations[0]?.suspended).toBe(true)
  expect(calls).toHaveLength(1)
})

test.each([401, 403, 429, 500])(
  'HTTP %s is unknown, not missing, and does not leak provider output',
  async (status) => {
    const result = await checkGitHubRepositoryAccess(
      'secret',
      'example',
      async () => new Response('sensitive provider detail', { status })
    )
    expect(result).toEqual({ status: 'unknown', personalAccountInstalled: null, complete: false, installations: [] })
  }
)

test('repository-list failure preserves verified installations and marks partial results', async () => {
  const { fetcher } = fixture([installation(), installation('another', 2)])
  const result = await checkGitHubRepositoryAccess('secret', 'example', async (input, init) =>
    String(input).includes('/2/repositories') ? new Response('', { status: 403 }) : fetcher(input, init)
  )
  expect(result.status).toBe('verified')
  expect(result.complete).toBe(false)
  expect(result.installations[1]?.repositoryCount).toBeNull()
})

test('truncated listings never claim a missing personal installation or absent repository access', async () => {
  const { fetcher, calls } = fixture(
    Array.from({ length: 20 }, (_, index) => installation(`org-${index}`, index + 1)),
    21,
    0
  )
  const result = await checkGitHubRepositoryAccess('secret', 'example', fetcher)
  expect(result.status).toBe('unknown')
  expect(result.personalAccountInstalled).toBeNull()
  expect(result.complete).toBe(false)
  expect(calls).toHaveLength(21)
})

test('malformed and oversized provider responses are safely unknown', async () => {
  for (const body of ['{}', 'x'.repeat(512 * 1024 + 1)]) {
    expect((await checkGitHubRepositoryAccess('secret', 'example', async () => new Response(body))).status).toBe(
      'unknown'
    )
  }
})
