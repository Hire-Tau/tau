import { describe, expect, test } from 'bun:test'
import { OPERATIONS_RECOMMENDATION_TRANSITIONS } from './types'
describe('operations recommendation lifecycle actions', () => {
  test('offers only API-valid actions for every state', () => {
    expect(OPERATIONS_RECOMMENDATION_TRANSITIONS).toEqual({
      open: ['acknowledged', 'dismissed', 'resolved'],
      acknowledged: ['open', 'dismissed', 'resolved'],
      dismissed: ['open'],
      resolved: ['open'],
    })
  })
})
