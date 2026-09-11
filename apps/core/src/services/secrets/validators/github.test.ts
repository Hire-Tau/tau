import { afterEach, describe, expect, mock, test } from 'bun:test'
import { validateGitHubToken } from './github'
import { getSecretValidator, isGitHubTokenKey } from '.'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

function githubResponse(init: { status?: number; login?: string | null; scopesHeader?: string | null }) {
  const headers = new Headers()
  if (init.scopesHeader !== undefined && init.scopesHeader !== null) headers.set('x-oauth-scopes', init.scopesHeader)
  return new Response(init.login === null ? 'not json' : JSON.stringify({ login: init.login ?? 'octocat' }), {
    status: init.status ?? 200,
    headers,
  })
}

function recordingFetch(res: Response) {
  const calls: { url: string; authorization: string | undefined }[] = []
  const fn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: (init?.headers as Record<string, string>)?.authorization })
    return res
  })
  return { fn, calls }
}

describe('validateGitHubToken', () => {
  test('200 + X-OAuth-Scopes header => valid classic PAT with scopes', async () => {
    const { fn, calls } = recordingFetch(githubResponse({ scopesHeader: 'repo, gist' }))
    const result = await validateGitHubToken('ghp_candidate', { fetchImpl: fn as unknown as typeof fetch })
    expect(result).toEqual({
      status: 'valid',
      login: 'octocat',
      tokenType: 'classic',
      scopes: ['repo', 'gist'],
      warnings: [],
    })
    expect(calls[0].url).toBe('https://api.github.com/user')
    expect(calls[0].authorization).toBe('Bearer ghp_candidate')
  })

  test('200 classic PAT missing repo scope => valid with a warning', async () => {
    const { fn } = recordingFetch(githubResponse({ scopesHeader: 'gist' }))
    const result = await validateGitHubToken('x', { fetchImpl: fn as unknown as typeof fetch })
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain("'repo'")
    }
  })

  test('200 with empty scopes header => valid with warning', async () => {
    const { fn } = recordingFetch(githubResponse({ scopesHeader: '' }))
    const result = await validateGitHubToken('x', { fetchImpl: fn as unknown as typeof fetch })
    expect(result.status).toBe('valid')
    if (result.status === 'valid') expect(result.warnings).toHaveLength(1)
  })

  test('200 without X-OAuth-Scopes header => fine-grained, no scope check', async () => {
    const { fn } = recordingFetch(githubResponse({ scopesHeader: null }))
    expect(await validateGitHubToken('github_pat_x', { fetchImpl: fn as unknown as typeof fetch })).toEqual({
      status: 'valid',
      login: 'octocat',
      tokenType: 'fine-grained',
      warnings: [],
    })
  })

  test('401 => invalid with a clear, body-free message', async () => {
    const { fn } = recordingFetch(new Response('{"message":"Bad credentials"}', { status: 401 }))
    const result = await validateGitHubToken('x', { fetchImpl: fn as unknown as typeof fetch })
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') {
      expect(result.message).toContain('401')
      expect(result.message).not.toContain('Bad credentials')
    }
  })

  test('403 SAML response => unverified without leaking GitHub body', async () => {
    const githubBody = 'Resource protected by organization SAML enforcement'
    const { fn } = recordingFetch(new Response(JSON.stringify({ message: githubBody }), { status: 403 }))
    const result = await validateGitHubToken('x', { fetchImpl: fn as unknown as typeof fetch })
    expect(result.status).toBe('unverified')
    if (result.status === 'unverified') expect(result.message).not.toContain(githubBody)
  })

  test('5xx => unverified', async () => {
    const { fn } = recordingFetch(new Response('', { status: 502 }))
    expect((await validateGitHubToken('x', { fetchImpl: fn as unknown as typeof fetch })).status).toBe('unverified')
  })

  test('network throw => unverified', async () => {
    const fn = mock(async () => {
      throw new TypeError('fetch failed')
    })
    expect((await validateGitHubToken('x', { fetchImpl: fn as unknown as typeof fetch })).status).toBe('unverified')
  })

  test('timeout => unverified', async () => {
    const fn = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    )
    expect((await validateGitHubToken('x', { fetchImpl: fn as unknown as typeof fetch, timeoutMs: 20 })).status).toBe(
      'unverified'
    )
  })

  test('200 with unparseable body or missing login => unverified', async () => {
    for (const res of [githubResponse({ login: null }), new Response('{"id":1}', { status: 200 })]) {
      const { fn } = recordingFetch(res)
      expect((await validateGitHubToken('x', { fetchImpl: fn as unknown as typeof fetch })).status).toBe('unverified')
    }
  })

  test('sends the GitHub API version header', async () => {
    const seen: RequestInit[] = []
    const fn = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init!)
      return githubResponse({ scopesHeader: 'repo' })
    })
    await validateGitHubToken('x', { fetchImpl: fn as unknown as typeof fetch })
    expect((seen[0].headers as Record<string, string>)['x-github-api-version']).toBe('2022-11-28')
  })
})

describe('GitHub secret validator registry', () => {
  test('matches only supported GitHub token keys', () => {
    for (const key of ['DEPLOY_GITHUB_PAGES_TOKEN']) {
      expect(isGitHubTokenKey(key)).toBe(false)
      expect(getSecretValidator(key)).toBeUndefined()
    }
    for (const key of [
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN_ACME',
      'GITHUB_TOKENX',
      'GITHUB_WEBHOOK_SECRET',
      'DEPLOY_VERCEL_TOKEN',
    ]) {
      expect(isGitHubTokenKey(key)).toBe(false)
      expect(getSecretValidator(key)).toBeUndefined()
    }
  })
})
