import { describe, expect, test } from 'bun:test'
import {
  decodeRecommendationCursor,
  encodeRecommendationCursor,
  InvalidRecommendationCursorError,
  RecommendationCursorResetRequiredError,
} from './cursor'

const keyset = { lastSeenAt: new Date('2026-01-02T03:04:05.000Z'), id: '00000000-0000-4000-8000-000000000001' }
const context = {
  status: 'open',
  squadId: null,
  identitySubject: 'user:00000000-0000-4000-8000-000000000002',
  squadScope: { kind: 'some' as const, squadIds: ['00000000-0000-4000-8000-000000000003'] },
}

describe('recommendation cursor codec', () => {
  test('round trips a keyset without exposing squad ids', () => {
    const cursor = encodeRecommendationCursor(keyset, context)
    expect(decodeRecommendationCursor(cursor, context)).toEqual(keyset)
    expect(Buffer.from(cursor, 'base64url').toString()).not.toContain(context.squadScope.squadIds[0])
  })

  test('rejects malformed and query-mismatched cursors', () => {
    expect(() => decodeRecommendationCursor('not-json', context)).toThrow(InvalidRecommendationCursorError)
    const cursor = encodeRecommendationCursor(keyset, context)
    expect(() => decodeRecommendationCursor(cursor, { ...context, status: 'resolved' })).toThrow(
      InvalidRecommendationCursorError
    )
  })

  test('requires a reset when authorization changes', () => {
    const cursor = encodeRecommendationCursor(keyset, context)
    expect(() =>
      decodeRecommendationCursor(cursor, {
        ...context,
        squadScope: { kind: 'some', squadIds: ['00000000-0000-4000-8000-000000000004'] },
      })
    ).toThrow(RecommendationCursorResetRequiredError)
  })
})
