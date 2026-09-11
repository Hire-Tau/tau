import { describe, expect, test } from 'bun:test'
import { messageEventData } from './message-event'

describe('messageEventData', () => {
  test('copies persisted non-empty response identity', () => {
    expect(
      messageEventData({
        id: 'm1',
        agentId: 'a1',
        metadata: { executionId: 'e1', streamGroupId: 'g1' },
      })
    ).toEqual({ messageId: 'm1', agentId: 'a1', executionId: 'e1', streamGroupId: 'g1' })
  })

  test.each([
    [{ executionId: '' }, { messageId: 'm1', agentId: 'a1' }],
    [
      { executionId: 1, streamGroupId: false },
      { messageId: 'm1', agentId: 'a1' },
    ],
    [undefined, { messageId: 'm1', agentId: 'a1' }],
    [{ executionId: 'e1' }, { messageId: 'm1', agentId: 'a1', executionId: 'e1' }],
    [{ streamGroupId: 'g1' }, { messageId: 'm1', agentId: 'a1', streamGroupId: 'g1' }],
  ])('omits invalid identity while retaining valid individual fields', (metadata, expected) => {
    const actual = messageEventData({ id: 'm1', agentId: 'a1', metadata })
    expect(actual).toEqual(expected)
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort())
  })
})
