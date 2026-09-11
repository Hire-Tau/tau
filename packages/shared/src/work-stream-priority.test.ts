import { describe, expect, it } from 'bun:test'
import {
  compareByEffectivePriorityThenCreatedAt,
  computeEffectivePriorities,
  priorityRank,
  type PriorityGraphStream,
} from './work-stream-priority'

function stream(overrides: Partial<PriorityGraphStream> & { id: string }): PriorityGraphStream {
  return {
    title: overrides.id,
    priority: 'normal',
    status: 'active',
    dependsOn: [],
    ...overrides,
  }
}

describe('priorityRank', () => {
  it('orders critical > high > normal > low', () => {
    expect(priorityRank('critical')).toBeGreaterThan(priorityRank('high'))
    expect(priorityRank('high')).toBeGreaterThan(priorityRank('normal'))
    expect(priorityRank('normal')).toBeGreaterThan(priorityRank('low'))
  })
})

describe('computeEffectivePriorities', () => {
  it('returns the stored priority when nothing depends on the stream', () => {
    const result = computeEffectivePriorities([stream({ id: 'a', priority: 'low' })])
    expect(result.get('a')).toEqual({ effective: 'low', viaId: null })
  })

  it('boosts a blocker to its dependent effective priority (direct edge)', () => {
    const result = computeEffectivePriorities([
      stream({ id: 'a', priority: 'low' }),
      stream({ id: 'b', priority: 'high', dependsOn: ['a'] }),
    ])
    expect(result.get('a')).toEqual({ effective: 'high', viaId: 'b' })
    expect(result.get('b')).toEqual({ effective: 'high', viaId: null })
  })

  it('boost is transitive: C(high) -> B -> A(low) gives A effective high', () => {
    const result = computeEffectivePriorities([
      stream({ id: 'a', priority: 'low' }),
      stream({ id: 'b', priority: 'normal', dependsOn: ['a'] }),
      stream({ id: 'c', priority: 'high', dependsOn: ['b'] }),
    ])
    expect(result.get('a')).toEqual({ effective: 'high', viaId: 'b' })
    expect(result.get('b')).toEqual({ effective: 'high', viaId: 'c' })
  })

  it('closing the dependent drops the boost (done/canceled contribute nothing)', () => {
    for (const closed of ['done', 'canceled'] as const) {
      const result = computeEffectivePriorities([
        stream({ id: 'a', priority: 'low' }),
        stream({ id: 'b', priority: 'normal', dependsOn: ['a'] }),
        stream({ id: 'c', priority: 'high', status: closed, dependsOn: ['b'] }),
      ])
      expect(result.get('a')).toEqual({ effective: 'normal', viaId: 'b' })
      expect(result.get('b')).toEqual({ effective: 'normal', viaId: null })
    }
  })

  it('queued dependents still boost their blockers (queued is open)', () => {
    const result = computeEffectivePriorities([
      stream({ id: 'a', priority: 'low' }),
      stream({ id: 'b', priority: 'critical', status: 'queued', dependsOn: ['a'] }),
    ])
    expect(result.get('a')).toEqual({ effective: 'critical', viaId: 'b' })
  })

  it('takes the max across multiple dependents (diamond)', () => {
    const result = computeEffectivePriorities([
      stream({ id: 'a', priority: 'low' }),
      stream({ id: 'b', priority: 'normal', dependsOn: ['a'] }),
      stream({ id: 'c', priority: 'high', dependsOn: ['a'] }),
      stream({ id: 'd', priority: 'critical', dependsOn: ['b', 'c'] }),
    ])
    expect(result.get('a')).toEqual({ effective: 'critical', viaId: expect.stringMatching(/^[bc]$/) })
  })

  it('ignores dependents referencing unknown streams and tolerates unknown deps', () => {
    const result = computeEffectivePriorities([stream({ id: 'a', priority: 'normal', dependsOn: ['missing'] })])
    expect(result.get('a')).toEqual({ effective: 'normal', viaId: null })
  })
})

describe('compareByEffectivePriorityThenCreatedAt', () => {
  it('sorts by effective priority desc, then createdAt asc, then id asc', () => {
    const entries = [
      { id: 'b', effective: 'high', createdAt: new Date('2026-01-02') },
      { id: 'a', effective: 'critical', createdAt: new Date('2026-01-03') },
      { id: 'd', effective: 'high', createdAt: new Date('2026-01-01') },
      { id: 'c', effective: 'high', createdAt: new Date('2026-01-01') },
    ] as const
    const sorted = [...entries].sort(compareByEffectivePriorityThenCreatedAt)
    expect(sorted.map((e) => e.id)).toEqual(['a', 'c', 'd', 'b'])
  })
})
