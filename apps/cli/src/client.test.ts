import { expect, test } from 'bun:test'
import { formatApiErrorPayload } from './client-errors'

test('formats bounded authoritative integration usage conflicts', () => {
  const message = formatApiErrorPayload(
    {
      error: 'Integration connection is assigned to squads',
      usage: {
        squadCount: 2,
        squads: [
          { id: 'a', name: 'Alpha' },
          { id: 'b', name: 'Beta' },
        ],
      },
    },
    'Request failed: 409'
  )
  expect(message).toBe('Integration connection is assigned to squads. Used by 2 squads: Alpha, Beta')
  expect(message.length).toBeLessThanOrEqual(500)
})
