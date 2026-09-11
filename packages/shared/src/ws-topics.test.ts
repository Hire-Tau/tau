import { describe, expect, test } from 'bun:test'
import { isValidTopic } from './ws-topics'

describe('WebSocket topics', () => {
  test('accepts only the bare actions invalidation topic', () => {
    expect(isValidTopic('actions')).toBe(true)
    expect(isValidTopic('actions:user-id')).toBe(false)
    expect(isValidTopic('actions:one:two')).toBe(false)
  })
})
