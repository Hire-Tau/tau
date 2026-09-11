import { describe, expect, it } from 'bun:test'
import { DependencyCycleError, assertNoDependencyCycle } from './dependency-graph'

const streams = [
  { id: 'a', title: 'Stream A', dependsOn: [] as string[] },
  { id: 'b', title: 'Stream B', dependsOn: ['a'] },
  { id: 'c', title: 'Stream C', dependsOn: ['b'] },
  { id: 'd', title: 'Stream D', dependsOn: [] as string[] },
]

describe('assertNoDependencyCycle', () => {
  it('rejects a self-edge', () => {
    expect(() => assertNoDependencyCycle(streams, 'a', ['a'])).toThrow(DependencyCycleError)
  })

  it('rejects a direct cycle (A -> B -> A)', () => {
    // b already depends on a; adding a -> b closes the loop
    expect(() => assertNoDependencyCycle(streams, 'a', ['b'])).toThrow(DependencyCycleError)
  })

  it('rejects a transitive cycle and names the path', () => {
    // c -> b -> a exists; adding a -> c closes a 3-cycle
    let error: unknown
    try {
      assertNoDependencyCycle(streams, 'a', ['c'])
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(DependencyCycleError)
    const cycleError = error as DependencyCycleError
    expect(cycleError.path[0]).toBe('Stream A')
    expect(cycleError.path[cycleError.path.length - 1]).toBe('Stream A')
    expect(cycleError.message).toContain('Stream A → Stream C → Stream B → Stream A')
  })

  it('keeps the pre-existing graph writable (acyclic writes pass)', () => {
    // d has no edges; c may depend on d in addition to b
    expect(() => assertNoDependencyCycle(streams, 'c', ['b', 'd'])).not.toThrow()
    // re-writing an existing edge set unchanged is fine
    expect(() => assertNoDependencyCycle(streams, 'b', ['a'])).not.toThrow()
  })

  it('tolerates dependencies on unknown (e.g. cross-squad) stream ids', () => {
    expect(() => assertNoDependencyCycle(streams, 'a', ['not-in-graph'])).not.toThrow()
  })
})
