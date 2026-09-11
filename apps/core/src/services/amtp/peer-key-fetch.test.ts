import { describe, test, expect } from 'bun:test'
import { fetchPeerAgentKey } from './peer-key-fetch'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('fetchPeerAgentKey', () => {
  test('fetches the public key and strips a trailing slash from baseUrl', async () => {
    let calledUrl = ''
    const fetchImpl = (async (url: string | URL) => {
      calledUrl = String(url)
      return jsonResponse({ handle: 'alice', instanceId: 'peer-1', identityPublicKey: 'PEM' })
    }) as unknown as typeof fetch

    const res = await fetchPeerAgentKey({ peerBaseUrl: 'https://peer.example/api/', handle: 'alice', fetchImpl })
    expect(calledUrl).toBe('https://peer.example/api/amtp/agents/alice/key')
    expect(res).toEqual({ handle: 'alice', instanceId: 'peer-1', identityPublicKey: 'PEM' })
  })

  test('throws on a non-2xx response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    await expect(
      fetchPeerAgentKey({ peerBaseUrl: 'https://peer.example/api', handle: 'ghost', fetchImpl })
    ).rejects.toThrow('PEER_KEY_FETCH_FAILED')
  })

  test('throws when the body lacks identityPublicKey', async () => {
    const fetchImpl = (async () => jsonResponse({ handle: 'alice', instanceId: 'peer-1' })) as unknown as typeof fetch
    await expect(
      fetchPeerAgentKey({ peerBaseUrl: 'https://peer.example/api', handle: 'alice', fetchImpl })
    ).rejects.toThrow('PEER_KEY_FETCH_FAILED')
  })
})
