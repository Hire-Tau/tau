import { describe, expect, test } from 'bun:test'
import { getWorkStreamLink } from './inboxWorkStreamLink'

describe('getWorkStreamLink', () => {
  test('returns a path when workStreamId and squadId are present', () => {
    expect(
      getWorkStreamLink({
        workStreamId: 'ws-1',
        squadId: 'sq-1',
        event: 'review',
      })
    ).toBe('/squads/sq-1/work?ws=ws-1')
  })

  test('prefers an encoded exact action path', () => {
    expect(
      getWorkStreamLink({
        squadId: 'sq-1',
        workStreamId: 'ws-1',
        waitId: 'manual-full-2',
        actionId: 'workstream-blocked:ws-1:manual-full-2',
      })
    ).toBe('/actions/workstream-blocked%3Aws-1%3Amanual-full-2')
  })

  test('returns null when workStreamId is missing', () => {
    expect(getWorkStreamLink({ squadId: 'sq-1' })).toBeNull()
  })

  test('returns null when squadId is missing', () => {
    expect(getWorkStreamLink({ workStreamId: 'ws-1' })).toBeNull()
  })

  test('returns null for unrelated metadata', () => {
    expect(getWorkStreamLink({ foo: 'bar' })).toBeNull()
  })

  test('returns null for empty object', () => {
    expect(getWorkStreamLink({})).toBeNull()
  })
})
