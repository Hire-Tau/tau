import { expect, test } from 'bun:test'
import { createClient } from '../client'
import type { Transport, RequestOptions } from '../transport'

const preset = {
  id: 'p1',
  document: {},
  visibility: 'private',
  ownerUserId: 'A',
  owner: { id: 'A', displayName: 'Ann' },
  revision: 1,
  createdAt: '',
  updatedAt: '',
}

function fakeTransport(calls: Array<{ path: string; options?: RequestOptions }>): Transport {
  return {
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
}

test('theme presets resource hits owner-scoped CRUD paths with revision-checked mutations', async () => {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const resource = createClient(fakeTransport(calls)).themePresets
  const signal = new AbortController().signal
  await resource.list(undefined, signal)
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

test('list defaults to no scope query param (server defaults to "mine"), and passes scope through when given', async () => {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const resource = createClient(fakeTransport(calls)).themePresets
  await resource.list()
  await resource.list('mine')
  await resource.list('shared')
  await resource.list('all')
  expect(calls.map((c) => c.path)).toEqual([
    '/theme-presets',
    '/theme-presets?scope=mine',
    '/theme-presets?scope=shared',
    '/theme-presets?scope=all',
  ])
})

test('Phase 2 sharing endpoints: setVisibility, removeShare and duplicate', async () => {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const resource = createClient(fakeTransport(calls)).themePresets
  const signal = new AbortController().signal
  await resource.setVisibility('p1', 1, 'instance', signal)
  await resource.removeShare('p1', signal)
  await resource.duplicate('p1', signal)
  expect(calls).toEqual([
    {
      path: '/theme-presets/p1/visibility',
      options: { method: 'PUT', body: { revision: 1, visibility: 'instance' }, signal },
    },
    { path: '/theme-presets/p1/share', options: { method: 'DELETE', signal } },
    { path: '/theme-presets/p1/duplicate', options: { method: 'POST', signal } },
  ])
})
