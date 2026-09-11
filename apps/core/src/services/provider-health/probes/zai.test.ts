import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { zaiProbe } from './zai'

// Restore globalThis.fetch after each test so the mock never leaks into later
// files in bun's single-process run (mock.restore() reverts spies, not a plain
// `globalThis.fetch = ...` assignment).
const originalFetch = globalThis.fetch

function res(body: unknown, status = 200, headers?: Record<string, string>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(headers),
  } as any
}

function quotaBody(remaining: number, nextResetTime?: number) {
  return {
    code: 200,
    success: true,
    data: {
      level: 'standard',
      limits: [
        {
          type: 'TOKENS_LIMIT',
          usage: 800_000_000,
          currentValue: 127_694_464,
          remaining,
          percentage: 15,
          ...(nextResetTime ? { nextResetTime } : {}),
        },
      ],
    },
  }
}

function quotaBodyWithLimits(limits: Array<Record<string, unknown>>) {
  return { code: 200, success: true, data: { level: 'standard', limits } }
}

describe('zaiProbe', () => {
  beforeEach(() => {
    mock.restore()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('reports healthy when all quota limits have remaining capacity', async () => {
    const f = mock(() => Promise.resolve(res(quotaBody(672_305_536))))
    globalThis.fetch = f as any

    const r = await zaiProbe.probe({ apiKey: 'k', baseUrl: 'https://api.z.ai/api/coding/paas/v4' })

    expect(r.state).toBe('healthy')
    expect(f).toHaveBeenCalledWith(
      'https://api.z.ai/api/monitor/usage/quota/limit',
      expect.objectContaining({ headers: { Authorization: 'Bearer k', Accept: 'application/json' } })
    )
  })

  it('derives the quota host from the China base URL', async () => {
    const f = mock(() => Promise.resolve(res(quotaBody(10))))
    globalThis.fetch = f as any

    await zaiProbe.probe({ apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/' })

    expect(f).toHaveBeenCalledWith('https://open.bigmodel.cn/api/monitor/usage/quota/limit', expect.anything())
  })

  it('reports plan-credit exhaustion when a token quota limit is depleted', async () => {
    const retryAt = Date.now() + 120_000
    globalThis.fetch = mock(() => Promise.resolve(res(quotaBody(0, retryAt)))) as any

    const r = await zaiProbe.probe({ apiKey: 'k', baseUrl: 'https://api.z.ai/api/coding/paas/v4' })

    expect(r.state).toBe('unhealthy')
    expect((r as any).kind).toBe('plan-credit')
    expect((r as any).retryAt).toBe(retryAt)
  })

  it('does not exhaust the model provider when only non-token coding-plan limits are depleted', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        res(
          quotaBodyWithLimits([
            { type: 'TOKENS_LIMIT', remaining: 10, percentage: 99 },
            { type: 'TIME_LIMIT', remaining: 0, percentage: 100 },
          ])
        )
      )
    ) as any

    const r = await zaiProbe.probe({ apiKey: 'k', baseUrl: 'https://api.z.ai/api/coding/paas/v4' })

    expect(r.state).toBe('healthy')
  })

  it('reports rate-limit on 429 and honors retry-after seconds', async () => {
    const before = Date.now()
    globalThis.fetch = mock(() => Promise.resolve(res({}, 429, { 'retry-after': '30' }))) as any

    const r = await zaiProbe.probe({ apiKey: 'k' })

    expect(r.state).toBe('unhealthy')
    expect((r as any).kind).toBe('rate-limit')
    expect(r.status).toBe(429)
    expect((r as any).retryAt).toBeGreaterThan(before + 29_000)
    expect((r as any).retryAt).toBeLessThan(before + 31_000)
  })

  it('reports invalid credentials on 401', async () => {
    globalThis.fetch = mock(() => Promise.resolve(res({}, 401))) as any

    const r = await zaiProbe.probe({ apiKey: 'k' })

    expect(r.state).toBe('unhealthy')
    expect((r as any).kind).toBe('invalid-credential')
    expect(r.status).toBe(401)
  })

  it('treats missing coding plan as no health signal instead of provider exhaustion', async () => {
    const f = mock(async () => res({ code: 500, success: false, msg: '当前用户不存在coding plan' }))
    globalThis.fetch = f as any

    const r = await zaiProbe.probe({ apiKey: 'k', baseUrl: 'https://api.z.ai/api/coding/paas/v4' })

    expect(r.state).toBe('inconclusive')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('reports error when a 200 response has success false for reasons other than missing coding plan', async () => {
    globalThis.fetch = mock(() => Promise.resolve(res({ code: 500, success: false, msg: 'unexpected error' }))) as any

    const r = await zaiProbe.probe({ apiKey: 'k' })

    expect(r.state).toBe('unhealthy')
    expect((r as any).kind).toBe('error')
  })

  it('returns inconclusive when no apiKey is configured', async () => {
    const f = mock(() => Promise.resolve(res({})))
    globalThis.fetch = f as any

    const r = await zaiProbe.probe({ apiKey: undefined })

    expect(r.state).toBe('inconclusive')
    expect(f).not.toHaveBeenCalled()
  })
})
