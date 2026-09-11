import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test'
import { startOAuthFlow } from './providerAuth'

// Stub the network at `globalThis.fetch` (what authFetch ultimately calls) so
// the assertions run against the REAL apiFetch path — no production DI seam and
// no process-global module mock.
type FetchCall = { url: string; method?: string; body?: string }
const calls: FetchCall[] = []
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  calls.length = 0
  originalFetch = globalThis.fetch
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, body: init?.body as string | undefined })
    return new Response(JSON.stringify({ provider: 'openai-codex', need: { kind: 'starting' }, status: 'started' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('startOAuthFlow request shape', () => {
  test('ADD flow (no accountId) posts with NO body — never signals reauthorize intent', async () => {
    await startOAuthFlow('openai-codex')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/provider-auth/openai-codex/oauth/start')
    expect(calls[0].method).toBe('POST')
    // Crucially, no accountId is smuggled in.
    expect(calls[0].body).toBeUndefined()
  })

  test('REAUTHORIZE flow (accountId) posts the accountId so completion targets that account', async () => {
    await startOAuthFlow('openai-codex', 'acc_123')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/provider-auth/openai-codex/oauth/start')
    expect(calls[0].method).toBe('POST')
    expect(JSON.parse(calls[0].body!)).toEqual({ accountId: 'acc_123' })
  })
})
