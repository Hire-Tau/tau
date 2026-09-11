import { describe, expect, test } from 'bun:test'
import { AGENT_NAME_POOL_SIZE, generateAgentName } from './agent-names'

describe('generateAgentName', () => {
  test('returns a name from the pool', () => {
    expect(typeof generateAgentName()).toBe('string')
    expect(generateAgentName().length).toBeGreaterThan(0)
  })

  test('avoids names already taken in scope', () => {
    // Take all but one name; the generator must return the only remaining one.
    const all = Array.from({ length: AGENT_NAME_POOL_SIZE }, (_, i) => i)
    // Build the full pool by draining it once into a set (each call avoids the running taken set).
    const pool = new Set<string>()
    const taken: string[] = []
    for (let i = 0; i < AGENT_NAME_POOL_SIZE; i++) {
      const name = generateAgentName(taken)
      expect(taken).not.toContain(name) // never collides while names remain
      taken.push(name)
      pool.add(name)
    }
    expect(pool.size).toBe(AGENT_NAME_POOL_SIZE) // drained the entire pool with zero collisions
    void all
  })

  test('falls back to reuse once the pool is exhausted', () => {
    const everyName = new Set<string>()
    const drained: string[] = []
    for (let i = 0; i < AGENT_NAME_POOL_SIZE; i++) {
      const n = generateAgentName(drained)
      drained.push(n)
      everyName.add(n)
    }
    // Pool fully taken → must still return a (reused) name rather than throw/empty.
    const reused = generateAgentName(everyName)
    expect(everyName.has(reused)).toBe(true)
  })
})
