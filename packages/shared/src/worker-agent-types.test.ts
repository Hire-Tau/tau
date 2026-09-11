import { expect, test } from 'bun:test'
import { isWorkerAgentType } from './types'

test('worker eligibility uses declared role and availability rather than reserved IDs', () => {
  const types = [
    { id: 'custom-system-role', systemOnly: true },
    { id: 'paused-worker', disabled: true },
    { id: 'researcher', systemOnly: false },
    { id: 'legacy-custom-worker' },
  ]
  expect(types.filter(isWorkerAgentType).map((type) => type.id)).toEqual(['researcher', 'legacy-custom-worker'])
})
