import { describe, expect, it } from 'bun:test'
import { getNextMessagesCursor } from './useInfiniteMessages'
import type { MessagesResponse } from '../api/agents'

const response = (pagination: MessagesResponse['pagination']): MessagesResponse => ({ messages: [], pagination })

describe('web message pagination cursor', () => {
  it('uses nextCursor and never falls back to oldestId', () => {
    expect(
      getNextMessagesCursor(response({ hasMore: true, totalCount: 2, nextCursor: 'opaque', oldestId: 'legacy' }))
    ).toBe('opaque')
    expect(getNextMessagesCursor(response({ hasMore: true, totalCount: 2, oldestId: 'legacy' }))).toBeUndefined()
    expect(getNextMessagesCursor(response({ hasMore: false, totalCount: 1, nextCursor: 'ignored' }))).toBeUndefined()
  })
})
