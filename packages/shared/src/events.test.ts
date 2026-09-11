import { describe, expect, test } from 'bun:test'
import type { EventMap, TopicEvent } from './index'

describe('message response identity event contract', () => {
  test('accepts legacy and enriched payloads', () => {
    const legacy = { messageId: 'm1', agentId: 'a1' } satisfies EventMap['message.created']
    const enriched = {
      messageId: 'm1',
      agentId: 'a1',
      executionId: 'e1',
      streamGroupId: 'g1',
    } satisfies EventMap['message.updated']

    expect(legacy.messageId).toBe('m1')
    expect(enriched).toMatchObject({ executionId: 'e1', streamGroupId: 'g1' })
  })

  test('message.updated is an agents topic event', () => {
    const event = {
      event: 'message.updated',
      data: { messageId: 'm1', agentId: 'a1', executionId: 'e1', streamGroupId: 'g1' },
    } satisfies TopicEvent<'agents'>

    expect(event.event).toBe('message.updated')
  })
})

describe('Action Center event contract', () => {
  test('action invalidation is content-free', () => {
    const payload = {} satisfies EventMap['actions.invalidated']
    const frame = { event: 'actions.invalidated', data: payload } satisfies TopicEvent<'actions'>

    expect(frame.data).toEqual({})
  })
})
