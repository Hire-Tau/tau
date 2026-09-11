import { describe, expect, it } from 'bun:test'
import { resolveExecutionConcurrencyKey } from './concurrency-limiter-instance'
import type { Execution } from '../../entities/Execution'

describe('resolveExecutionConcurrencyKey', () => {
  it('returns undefined when a queued execution provider cannot be resolved', async () => {
    const execution = {
      async mustGetAgent() {
        throw new Error('agent missing')
      },
    } as unknown as Execution

    await expect(resolveExecutionConcurrencyKey(execution)).resolves.toBeUndefined()
  })
})
