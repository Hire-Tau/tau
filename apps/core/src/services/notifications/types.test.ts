import { describe, test, expect } from 'bun:test'
import type { NotificationRule, NotificationConfig, EventContext } from './types'

describe('Notification Types', () => {
  test('NotificationRule type is valid', () => {
    const rule: NotificationRule = {
      event: 'inbox.messageReceived',
      channels: ['console'],
    }
    expect(rule.event).toBe('inbox.messageReceived')
    expect(rule.channels).toEqual(['console'])
  })

  test('NotificationRule with multiple channels', () => {
    const rule: NotificationRule = {
      event: 'execution.failed',
      channels: ['console', 'push', 'discord'],
    }
    expect(rule.channels).toHaveLength(3)
  })

  test('NotificationConfig type is valid', () => {
    const config: NotificationConfig = {
      rules: [{ channels: ['console'] }],
      channels: {
        console: { enabled: true },
      },
    }
    expect(config.rules.length).toBe(1)
  })

  test('EventContext type is valid', () => {
    const ctx: EventContext = {
      event: 'inbox.messageReceived',
    }
    expect(ctx.event).toBe('inbox.messageReceived')
  })
})
