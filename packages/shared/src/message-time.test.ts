import { describe, expect, test } from 'bun:test'
import { messageSortAt } from './message-time'

const createdAt = new Date('2026-08-10T10:00:00.100Z')

describe('messageSortAt', () => {
  test('uses consumedAt only for a consumed human row', () => {
    expect(
      messageSortAt({
        role: 'human',
        createdAt,
        metadata: { consumedAt: '2026-08-10T10:30:00.456789Z' },
      })
    ).toBe(Date.parse('2026-08-10T10:30:00.456Z'))
  })

  test('falls back to createdAt for a legacy human row', () => {
    expect(messageSortAt({ role: 'human', createdAt, metadata: null })).toBe(createdAt.getTime())
  })

  test('accepts an ISO createdAt from JSON transport', () => {
    expect(messageSortAt({ role: 'assistant', createdAt: '2026-08-10T10:00:00.100Z', metadata: null })).toBe(
      createdAt.getTime()
    )
  })

  test('ignores consumedAt metadata on assistant rows', () => {
    expect(
      messageSortAt({
        role: 'assistant',
        createdAt,
        metadata: { consumedAt: '2026-08-10T11:00:00.000Z' },
      })
    ).toBe(createdAt.getTime())
  })
})
