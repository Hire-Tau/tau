import { expect, test } from 'bun:test'
import { createClient } from '../client'
import type { Transport, RequestOptions } from '../transport'

test('theme presets resource hits owner-scoped CRUD paths with revision-checked mutations', async () => {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const preset = {
    id: 'p1',
    document: {},
    visibility: 'private',
    ownerUserId: 'A',
    revision: 1,
    createdAt: '',
    updatedAt: '',
  }
  const transport: Transport = {
    request: async <T>(path: string, options?: RequestOptions) => {
      calls.push({ path, options })
      return preset as T
    },
    openStream: async () => {
      throw new Error('unused')
    },
    wsUrl: (p) => p,
    url: (p) => p,
  }
  const resource = createClient(transport).themePresets
  const signal = new AbortController().signal
  await resource.list(signal)
  await resource.get('p1', signal)
  await resource.create({ name: 'x' }, signal)
  await resource.update('p1', 1, { name: 'y' }, signal)
  await resource.delete('p1', 1, signal)
  expect(calls).toEqual([
    { path: '/theme-presets', options: { signal } },
    { path: '/theme-presets/p1', options: { signal } },
    { path: '/theme-presets', options: { method: 'POST', body: { document: { name: 'x' } }, signal } },
    { path: '/theme-presets/p1', options: { method: 'PUT', body: { revision: 1, document: { name: 'y' } }, signal } },
    { path: '/theme-presets/p1', options: { method: 'DELETE', body: { revision: 1 }, signal } },
  ])
})
