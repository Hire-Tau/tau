import { describe, expect, test } from 'bun:test'
import type { PendingItem, RenderItem } from './types'

describe('conversation layer types', () => {
  test('RenderItem discriminates on kind', () => {
    const items: RenderItem[] = [
      { kind: 'streaming', id: 'S', agentId: 'a', blocks: [], status: 'streaming' },
      { kind: 'pending', id: 'c1', content: 'hi', status: 'sending' },
    ]
    const kinds = items.map((i) => i.kind)
    expect(kinds).toEqual(['streaming', 'pending'])
  })

  test('PendingItem carries a client clock for ordering', () => {
    const p: PendingItem = { clientId: 'c1', content: 'hi', status: 'sending', createdAt: 5 }
    expect(p.createdAt).toBe(5)
  })
})
