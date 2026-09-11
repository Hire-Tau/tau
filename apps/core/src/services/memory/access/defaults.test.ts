import { describe, it, expect } from 'bun:test'
import { resolveSearchDefaults, type DefaultLayers } from './defaults'

describe('resolveSearchDefaults', () => {
  it('starts from system default of own + granted with no filters', () => {
    const out = resolveSearchDefaults({})
    expect(out.sourceSquadIds).toBeUndefined()
    expect(out.sensitivity).toBeUndefined()
    expect(out.sourceTypes).toBeUndefined()
    expect(out.paths).toBeUndefined()
  })

  it('applies later layers over earlier layers', () => {
    const layers: DefaultLayers = {
      squad: { sourceTypes: ['memory_file'], sensitivity: 'internal' },
      agentType: { sourceTypes: ['agent_thread'] },
      agent: { paths: ['/memory/agent/**'] },
      request: { sourceTypes: ['workspace_file'] },
    }

    const out = resolveSearchDefaults(layers)
    expect(out.sourceTypes).toEqual(['workspace_file'])
    expect(out.sensitivity).toBe('internal')
    expect(out.paths).toEqual(['/memory/agent/**'])
  })
})
