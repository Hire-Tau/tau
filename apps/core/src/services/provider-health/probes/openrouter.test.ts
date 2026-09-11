import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { openRouterProbe } from './openrouter'

// Restore globalThis.fetch after each test so the mock never leaks into later
// files in bun's single-process run (mock.restore() reverts spies, not a plain
// `globalThis.fetch = ...` assignment).
const originalFetch = globalThis.fetch

function ok(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
  } as any
}

describe('openRouterProbe', () => {
  beforeEach(() => {
    mock.restore()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('reports healthy when credits remain', async () => {
    const f = mock(() => Promise.resolve(ok({ data: { total_credits: 100, total_usage: 10 } })))
    globalThis.fetch = f as any
    const r = await openRouterProbe.probe({ apiKey: 'k' })
    expect(r.state).toBe('healthy')
    expect(f).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/credits'),
      expect.objectContaining({ headers: { Authorization: 'Bearer k' } })
    )
  })

  it('reports plan-credit exhaustion when total_credits <= 0', async () => {
    globalThis.fetch = mock(() => Promise.resolve(ok({ data: { total_credits: 0, total_usage: 0 } }))) as any
    const r = await openRouterProbe.probe({ apiKey: 'k' })
    expect(r.state).toBe('unhealthy')
    expect((r as any).kind).toBe('plan-credit')
  })

  it('reports rate-limit on 429', async () => {
    globalThis.fetch = mock(() => Promise.resolve(ok({}, 429))) as any
    const r = await openRouterProbe.probe({ apiKey: 'k' })
    expect(r.state).toBe('unhealthy')
    expect((r as any).kind).toBe('rate-limit')
    expect(r.status).toBe(429)
  })

  it('reports invalid credentials on 401', async () => {
    globalThis.fetch = mock(() => Promise.resolve(ok({}, 401))) as any
    const r = await openRouterProbe.probe({ apiKey: 'k' })
    expect(r.state).toBe('unhealthy')
    expect((r as any).kind).toBe('invalid-credential')
    expect(r.status).toBe(401)
  })

  it('reports plan-credit on 402', async () => {
    globalThis.fetch = mock(() => Promise.resolve(ok({}, 402))) as any
    const r = await openRouterProbe.probe({ apiKey: 'k' })
    expect(r.state).toBe('unhealthy')
    expect((r as any).kind).toBe('plan-credit')
  })

  it('reports error on an unexpected non-ok status', async () => {
    globalThis.fetch = mock(() => Promise.resolve(ok({}, 500))) as any
    const r = await openRouterProbe.probe({ apiKey: 'k' })
    expect(r.state).toBe('inconclusive')
  })

  it('returns inconclusive when no apiKey is configured', async () => {
    const f = mock(() => Promise.resolve(ok({})))
    globalThis.fetch = f as any
    const r = await openRouterProbe.probe({ apiKey: undefined })
    expect(r.state).toBe('inconclusive')
    expect(f).not.toHaveBeenCalled()
  })

  it('honors a baseUrl override', async () => {
    const f = mock(() => Promise.resolve(ok({ data: { total_credits: 5 } })))
    globalThis.fetch = f as any
    await openRouterProbe.probe({ apiKey: 'k', baseUrl: 'https://custom.example.com/v1/' })
    expect(f).toHaveBeenCalledWith('https://custom.example.com/v1/credits', expect.anything())
  })
})
