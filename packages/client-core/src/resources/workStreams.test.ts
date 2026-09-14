import { expect, test } from 'bun:test'
import type { RequestOptions, Transport } from '../transport'
import { workStreamsResource } from './workStreams'

test('cleanup setting uses the supported PATCH route and preserves explicit false', async () => {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const transport: Transport = {
    request: async <T>(path: string, options?: RequestOptions) => {
      calls.push({ path, options })
      return { id: 'stream' } as T
    },
    openStream: async () => {
      throw Error('not used')
    },
    wsUrl: (path) => `ws://test${path}`,
    url: (path) => `http://test${path}`,
  }
  await workStreamsResource(transport).setAutoCleanupWorktree('stream/path', false)
  expect(calls).toEqual([
    { path: '/workstreams/stream%2Fpath', options: { method: 'PATCH', body: { autoCleanupWorktree: false } } },
  ])
})
