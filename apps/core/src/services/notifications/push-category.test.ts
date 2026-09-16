import { describe, expect, test } from 'bun:test'
import { pushCategoryFor } from './push-category'

const base = { title: 't', body: 'b', timestamp: new Date() }

describe('pushCategoryFor', () => {
  test('agent questions are their own category regardless of payload', () => {
    expect(pushCategoryFor('agent-question.created', { ...base, type: 'agent-question.created' }, {})).toBe('question')
  })

  test('inbox events split by work-stream kind, fleet source, and Assistant recipient', () => {
    const inbox = (event: Record<string, unknown>, data: Record<string, unknown> = { recipientType: 'user' }) =>
      pushCategoryFor('inbox.messageReceived', { ...base, type: 'inbox.messageReceived', ...event }, data)
    expect(inbox({ notificationKind: 'workStream.review' })).toBe('review')
    expect(inbox({ notificationKind: 'workStream.done' })).toBe('done')
    expect(inbox({ source: 'fleet-alert' }, { recipientType: 'system' })).toBe('fleet')
    expect(inbox({}, { recipientType: 'voice_assistant', recipientId: 'assistant:x' })).toBe('assistant')
    expect(inbox({})).toBe('message')
    expect(inbox({ notificationKind: 'workStream.blocked' })).toBe('message')
  })

  test('an unbuilt event still resolves to a category', () => {
    expect(pushCategoryFor('inbox.messageReceived', null, { recipientType: 'user' })).toBe('message')
    expect(pushCategoryFor('execution.failed', null, {})).toBe('message')
  })
})
