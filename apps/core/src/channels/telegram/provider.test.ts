import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { telegramProvider } from './provider'
import type { ChannelInstance } from '../../entities/ChannelInstance'
import type { NotificationEvent } from '../provider'

describe('telegramProvider.sendNotification', () => {
  const mockFetch = mock(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }))
  const originalEnv = process.env.TELEGRAM_BOT_TOKEN
  // bun runs the whole suite in ONE process: an unrestored `globalThis.fetch`
  // is handed to whichever file runs next, and this stub is not a Response.
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockFetch.mockClear()
    process.env.TELEGRAM_BOT_TOKEN = '123456:ABC-test-token'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env.TELEGRAM_BOT_TOKEN = originalEnv
  })

  it('sends notification to chat via Telegram API', async () => {
    const instance = {
      providerConfig: {},
    } as unknown as ChannelInstance

    const event: NotificationEvent = {
      type: 'workStream.done',
      squadId: 'squad-1',
      squadName: 'Test Squad',
      title: '✅ Done: Feature X',
      body: 'Implementation complete',
      url: 'http://localhost/workstreams/1',
      timestamp: new Date('2026-03-03T12:00:00Z'),
    }

    await telegramProvider.sendNotification!({
      instance,
      channelId: '-100123456789',
      event,
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.telegram.org/bot123456:ABC-test-token/sendMessage')
    const body = JSON.parse(opts.body as string)
    expect(body.chat_id).toBe('-100123456789')
    expect(body.parse_mode).toBe('MarkdownV2')
    expect(body.text).toContain('Done: Feature X')
  })
})
