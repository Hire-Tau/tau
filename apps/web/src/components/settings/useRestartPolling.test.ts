import { afterEach, describe, expect, mock, test } from 'bun:test'
import { nextRestartState, probeHealthy } from './useRestartPolling'

describe('nextRestartState — restart reconnect transition table', () => {
  test('waiting-down + unhealthy (dead API / 502) → waiting-up', () => {
    // The load-bearing case: the server going down must advance the poll.
    expect(nextRestartState('waiting-down', false)).toBe('waiting-up')
  })

  test('waiting-down + healthy → stays waiting-down (no premature advance)', () => {
    // The API is briefly still up between the request and the process exit;
    // must NOT jump ahead to waiting-up.
    expect(nextRestartState('waiting-down', true)).toBe('waiting-down')
  })

  test('waiting-up + healthy → idle (reconnected)', () => {
    expect(nextRestartState('waiting-up', true)).toBe('idle')
  })

  test('waiting-up + unhealthy → stays waiting-up (still restarting)', () => {
    expect(nextRestartState('waiting-up', false)).toBe('waiting-up')
  })
})

describe('probeHealthy — down-detection at the fix site', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('a reverse-proxy 502 (RESOLVED, not thrown) is unhealthy', async () => {
    // This is the exact bug: behind caddy a dead upstream answers 502 as a
    // resolved response, so catch-only detection never fired. res.ok === false
    // must be treated as down.
    globalThis.fetch = mock(async () => new Response(null, { status: 502 })) as unknown as typeof fetch
    expect(await probeHealthy('/health')).toBe(false)
  })

  test('a 200 is healthy', async () => {
    globalThis.fetch = mock(async () => new Response('{"status":"ok"}', { status: 200 })) as unknown as typeof fetch
    expect(await probeHealthy('/health')).toBe(true)
  })

  test('a thrown fetch (connection-refused, local dev) is unhealthy', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect(await probeHealthy('/health')).toBe(false)
  })
})
