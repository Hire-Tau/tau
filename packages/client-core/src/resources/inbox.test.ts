import { describe, expect, test } from 'bun:test'
import { inboxResource } from './inbox'
import type { Transport, RequestOptions } from '../transport'

function mockTransport(responder?: (path: string, options?: RequestOptions) => unknown) {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const t: Transport = {
    request: async <T>(path: string, options?: RequestOptions) => {
      calls.push({ path, options })
      return (responder?.(path, options) ?? undefined) as T
    },
    openStream: async () => {
      throw new Error('not used')
    },
    wsUrl: (path: string) => `ws://test${path}`,
    url: (path: string) => `http://test/api${path}`,
  }
  return { t, calls }
}

describe('inboxResource', () => {
  test('sendInboxMessage posts voice assistant inbox messages with delivery mode', async () => {
    const { t, calls } = mockTransport(() => ({
      id: 'inbox-message-1',
      recipientType: 'agent',
      recipientId: 'agent-1',
      senderType: 'voice_assistant',
      senderId: 'workspace',
      subject: null,
      content: 'Please inspect this.',
      metadata: {},
      readAt: null,
      deliveredAt: '2026-05-03T15:00:00.000Z',
      deliveryMode: 'steer',
      createdAt: '2026-05-03T15:00:00.000Z',
    }))

    const response = await inboxResource(t).sendInboxMessage({
      recipientType: 'agent',
      recipientId: 'agent-1',
      asVoiceAssistant: true,
      content: 'Please inspect this.',
      deliveryMode: 'steer',
    })

    expect(calls[0].path).toBe('/inbox')
    expect(calls[0].options?.method).toBe('POST')
    expect(calls[0].options?.body).toEqual({
      recipientType: 'agent',
      recipientId: 'agent-1',
      asVoiceAssistant: true,
      content: 'Please inspect this.',
      deliveryMode: 'steer',
    })
    expect(response.senderType).toBe('voice_assistant')
    expect(response.deliveryMode).toBe('steer')
  })

  test('getMyInbox adds ?all=true only when includeRead', async () => {
    const { t, calls } = mockTransport(() => [])
    await inboxResource(t).getMyInbox()
    await inboxResource(t).getMyInbox(true)
    expect(calls[0].path).toBe('/inbox/user/me')
    expect(calls[1].path).toBe('/inbox/user/me?all=true')
  })

  test('getAgentInbox hits /inbox/agent/:id and adds ?all=true only when includeRead', async () => {
    const { t, calls } = mockTransport(() => [])
    await inboxResource(t).getAgentInbox('agt-1')
    await inboxResource(t).getAgentInbox('agt-1', true)
    expect(calls[0].path).toBe('/inbox/agent/agt-1')
    expect(calls[1].path).toBe('/inbox/agent/agt-1?all=true')
  })

  test('getAgentInboxUnreadCount hits the count route', async () => {
    const { t, calls } = mockTransport(() => ({ count: 3 }))
    const res = await inboxResource(t).getAgentInboxUnreadCount('agt-1')
    expect(calls[0].path).toBe('/inbox/agent/agt-1/count')
    expect(res).toEqual({ count: 3 })
  })

  test('getAgentInboxPage requests unread messages with limit and cursor', async () => {
    const { t, calls } = mockTransport(() => ({ items: [], hasMore: false, nextCursor: null, totalCount: 0 }))
    await inboxResource(t).getAgentInboxPage('agt-1', { readState: 'unread', limit: 20, cursor: 'msg-20' })
    expect(calls[0].path).toBe('/inbox/agent/agt-1?limit=20&readState=unread&cursor=msg-20')
  })

  test('getAgentInboxPage requests read messages separately', async () => {
    const { t, calls } = mockTransport(() => ({ items: [], hasMore: false, nextCursor: null, totalCount: 0 }))
    await inboxResource(t).getAgentInboxPage('agt-1', { readState: 'read', limit: 10 })
    expect(calls[0].path).toBe('/inbox/agent/agt-1?limit=10&readState=read')
  })

  test('getMyInboxPage requests cursor-paginated user inbox messages', async () => {
    const { t, calls } = mockTransport(() => ({ items: [], hasMore: false, nextCursor: null, totalCount: 0 }))
    await inboxResource(t).getMyInboxPage({ readState: 'read', limit: 25, cursor: 'msg-25' })
    expect(calls[0].path).toBe('/inbox/user/me?limit=25&readState=read&cursor=msg-25')
  })

  test('getSystemInboxPage requests cursor-paginated system inbox messages', async () => {
    const { t, calls } = mockTransport(() => ({ items: [], hasMore: false, nextCursor: null, totalCount: 0 }))
    await inboxResource(t).getSystemInboxPage({ readState: 'read', limit: 25 })
    expect(calls[0].path).toBe('/inbox/system/system?limit=25&readState=read')
  })
})
