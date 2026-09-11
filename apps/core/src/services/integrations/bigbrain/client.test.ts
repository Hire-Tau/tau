import { expect, test } from 'bun:test'
import { BigbrainClient } from './client'

const secret = 'fixture-secret'
test('uses fixed encoded endpoints and bearer only in the authorization header', async () => {
  const requests: Request[] = []
  const client = new BigbrainClient({
    apiBase: 'https://brain.example',
    credential: () => secret,
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      return Response.json({ hits: [] })
    },
  })
  expect(await client.search('hello world', 10)).toEqual({ hits: [] })
  expect(requests[0]!.url).toBe('https://brain.example/v1/search?q=hello%20world&n=10')
  expect(requests[0]!.headers.get('authorization')).toBe(`Bearer ${secret}`)
  expect(requests[0]!.url).not.toContain(secret)
})

test.each([
  [401, 'invalid_auth'],
  [403, 'missing_scope'],
  [500, 'unavailable'],
] as const)('sanitizes HTTP %s', async (status, code) => {
  const client = new BigbrainClient({
    apiBase: 'https://brain.example',
    credential: () => secret,
    fetch: async () => new Response(`remote body ${secret}`, { status }),
  })
  try {
    await client.validate()
    throw new Error('expected rejection')
  } catch (error) {
    expect(JSON.stringify(error)).toContain(code)
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain('remote body')
  }
})

test.each([
  ['whoami', () => ({ scopes: ['vault:read'], extra: true }), (client: BigbrainClient) => client.validate()],
  ['search malformed hit', () => ({ hits: [{ path: 42 }] }), (client: BigbrainClient) => client.search('query')],
  [
    'search oversized hit count',
    () => ({ hits: Array.from({ length: 51 }, () => ({ path: 'note.md' })) }),
    (client: BigbrainClient) => client.search('query'),
  ],
  [
    'note oversized content',
    () => ({ path: 'note.md', content: 'x'.repeat(200 * 1024) }),
    (client: BigbrainClient) => client.getNote('note.md'),
  ],
  [
    'drop unknown field',
    () => ({ path: 'drop.md', secret: 'unexpected' }),
    (client: BigbrainClient) => client.dropMarkdown('body'),
  ],
] as const)('rejects invalid_response for %s response shapes', async (_name, body, invoke) => {
  const client = new BigbrainClient({
    apiBase: 'https://brain.example',
    credential: () => secret,
    fetch: async () => Response.json(body()),
  })
  await expect(invoke(client)).rejects.toMatchObject({ code: 'invalid_response' })
})

test('rejects insecure non-loopback bases and oversized streamed bodies', async () => {
  expect(() => new BigbrainClient({ apiBase: 'http://brain.example', credential: () => secret })).toThrow()
  const client = new BigbrainClient({
    apiBase: 'https://brain.example',
    credential: () => secret,
    fetch: async () => new Response(new Uint8Array(256 * 1024 + 1)),
  })
  await expect(client.validate()).rejects.toMatchObject({ code: 'response_too_large' })
})
