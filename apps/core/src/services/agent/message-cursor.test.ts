import { describe, expect, it } from 'bun:test'
import { decodeMessageCursor, encodeMessageCursor, InvalidMessageCursorError } from './message-cursor'

const context = { agentId: 'agent', role: 'human', search: 'needle' }

describe('message cursor', () => {
  it('round trips a frozen compound keyset', () => {
    const keyset = { createdAt: new Date('2026-08-10T12:00:00.000Z'), enqueueOrder: 123n }
    expect(decodeMessageCursor(encodeMessageCursor(keyset, context), context)).toEqual(keyset)
  })
  it.each(['', 'not json', Buffer.from('{}').toString('base64url')])('rejects malformed cursor %p', (cursor) => {
    expect(() => decodeMessageCursor(cursor, context)).toThrow(InvalidMessageCursorError)
  })
  it('rejects cursor reuse with different query context', () => {
    const cursor = encodeMessageCursor({ createdAt: new Date('2026-08-10T12:00:00.000Z'), enqueueOrder: 1n }, context)
    expect(() => decodeMessageCursor(cursor, { ...context, search: 'other' })).toThrow(InvalidMessageCursorError)
  })

  it('accepts PostgreSQL bigint boundaries and rejects overflow', () => {
    const createdAt = new Date('2026-08-10T12:00:00.000Z')
    for (const enqueueOrder of [-9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n]) {
      const cursor = encodeMessageCursor({ createdAt, enqueueOrder }, context)
      expect(decodeMessageCursor(cursor, context)).toEqual({ createdAt, enqueueOrder })
    }
    for (const enqueueOrder of [-9_223_372_036_854_775_809n, 9_223_372_036_854_775_808n]) {
      const cursor = encodeMessageCursor({ createdAt, enqueueOrder }, context)
      expect(() => decodeMessageCursor(cursor, context)).toThrow(InvalidMessageCursorError)
    }
  })

  it('rejects noncanonical bigint and timestamps', () => {
    for (const payload of [
      { v: 1, createdAt: '2026-08-10T12:00:00Z', enqueueOrder: '1', queryDigest: 'a'.repeat(64) },
      { v: 1, createdAt: '2026-08-10T12:00:00.000Z', enqueueOrder: '01', queryDigest: 'a'.repeat(64) },
    ])
      expect(() => decodeMessageCursor(Buffer.from(JSON.stringify(payload)).toString('base64url'), context)).toThrow(
        InvalidMessageCursorError
      )
  })
})
