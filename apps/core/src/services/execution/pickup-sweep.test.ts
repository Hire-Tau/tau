import { describe, expect, test } from 'bun:test'
import { sweepQueuedExecutionCandidates, type PickupResult } from './pickup'

describe('queued execution pickup sweep', () => {
  test('continues past a provider-saturated candidate and starts a later eligible candidate', async () => {
    const attempted: string[] = []
    const outcomes = new Map<string, PickupResult>([
      ['saturated-limited-provider', 'no-capacity'],
      ['eligible-unlimited-provider', 'started'],
    ])

    const pickedUp = await sweepQueuedExecutionCandidates(
      ['saturated-limited-provider', 'eligible-unlimited-provider'],
      2,
      async (candidate) => {
        attempted.push(candidate)
        return outcomes.get(candidate)!
      }
    )

    expect(pickedUp).toBe(1)
    expect(attempted).toEqual(['saturated-limited-provider', 'eligible-unlimited-provider'])
  })

  test('stops once genuine global capacity is exhausted', async () => {
    const attempted: string[] = []

    const pickedUp = await sweepQueuedExecutionCandidates(['first', 'beyond-global-capacity'], 1, async (candidate) => {
      attempted.push(candidate)
      return 'started'
    })

    expect(pickedUp).toBe(1)
    expect(attempted).toEqual(['first'])
  })
})
