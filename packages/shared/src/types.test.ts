import { describe, test, expect } from 'bun:test'
import type { InboxAttachment, InboxMessage, MessageMetadata, StreamEvent } from './types'

describe('InboxAttachment type', () => {
  test('an InboxMessage can carry attachments', () => {
    const att: InboxAttachment = {
      id: 'a1',
      messageId: 'm1',
      filename: 'f.txt',
      contentType: 'text/plain',
      byteSize: 3,
      sha256: 'abc',
      createdAt: new Date(),
    }
    const msg = { attachments: [att] } as Partial<InboxMessage>
    expect(msg.attachments?.[0].filename).toBe('f.txt')
  })
})

describe('streaming reconciliation type additions', () => {
  test('done event carries streamGroupId and messageIds', () => {
    const done: StreamEvent = {
      type: 'done',
      response: 'hi',
      streamGroupId: 'exec-1:run:1',
      messageIds: ['m1', 'm2'],
    }
    expect(done.type === 'done' && done.messageIds).toEqual(['m1', 'm2'])
    expect(done.type === 'done' && done.streamGroupId).toBe('exec-1:run:1')
  })

  test('message metadata carries clientId and consumedAt', () => {
    const meta: MessageMetadata = { clientId: 'c-123', consumedAt: '2026-06-25T00:00:00.000Z' }
    expect(meta.clientId).toBe('c-123')
    expect(meta.consumedAt).toBe('2026-06-25T00:00:00.000Z')
  })
})
