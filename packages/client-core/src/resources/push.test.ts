import { describe, expect, test } from 'bun:test'
import { pushResource } from './push'
import type { RequestOptions, Transport } from '../transport'

function mockTransport(responder?: (path: string, options?: RequestOptions) => unknown) {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const t: Transport = {
    request: async <T>(path: string, options?: RequestOptions) => {
      calls.push({ path, options })
      return (responder?.(path, options) ?? undefined) as T
    },
    openStream: async () => {
      throw new Error('not used')
    },
    wsUrl: (path: string) => `ws://test${path}`,
    url: (path: string) => `http://test/api${path}`,
  }
  return { t, calls }
}

describe('pushResource', () => {
  test('fetches the server-authoritative work interest snapshot', async () => {
    const expected = {
      asOf: '2026-08-30T00:00:00.000Z',
      totalCount: 0,
      bucketCounts: { needsYou: 0, running: 0, blocked: 0, queued: 0 },
      top: [],
      liveActivity: { activeCount: 0, needsYouCount: 0, top: [] },
    }
    const { t, calls } = mockTransport(() => expected)

    expect(await pushResource(t).getWorkInterestSnapshot()).toEqual(expected)
    expect(calls).toEqual([{ path: '/push/work-interest', options: undefined }])
  })

  test('listDevices fetches APNs device registrations without a request body', async () => {
    const { t, calls } = mockTransport(() => [
      { id: 'device-1', platform: 'ios', environment: 'sandbox', createdAt: '2026-07-05T00:00:00.000Z' },
    ])

    const devices = await pushResource(t).listDevices()

    expect(devices).toEqual([
      { id: 'device-1', platform: 'ios', environment: 'sandbox', createdAt: '2026-07-05T00:00:00.000Z' },
    ])
    expect(calls).toEqual([{ path: '/push/device', options: undefined }])
  })
})
