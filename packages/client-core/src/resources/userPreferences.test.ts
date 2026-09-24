import { expect, test } from 'bun:test'
import { createClient } from '../client'
import type { Transport, RequestOptions } from '../transport'

test('self-service resource uses the shared transport, whole preference and session identity precondition', async () => {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const theme = { themeId: 'harbor', appearance: 'dark' as const, customTheme: null, presetId: null }
  const result = { userId: 'A', theme }
  const transport: Transport = {
    request: async <T>(path: string, options?: RequestOptions) => {
      calls.push({ path, options })
      return result as T
    },
    openStream: async () => {
      throw new Error('unused')
    },
    wsUrl: (p) => p,
    url: (p) => p,
  }
  const resource = createClient(transport).userPreferences
  const signal = new AbortController().signal
  expect(await resource.getMine(signal)).toEqual(result)
  expect(await resource.updateMine({ expectedUserId: 'A', theme }, signal)).toEqual(result)
  expect(calls).toEqual([
    { path: '/user-preferences/me', options: { signal } },
    { path: '/user-preferences/me', options: { method: 'PUT', body: { expectedUserId: 'A', theme }, signal } },
  ])
})
