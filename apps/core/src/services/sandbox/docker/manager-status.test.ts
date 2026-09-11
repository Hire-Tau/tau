import { describe, expect, it } from 'bun:test'
import { classifyDockerContainerOwnership, classifyDockerInspectStatus } from './lifecycle-contract'

describe('classifyDockerInspectStatus', () => {
  it('treats any inspect success as present', () => {
    expect(classifyDockerInspectStatus(0, '')).toBe('running')
  })

  it('recognizes only an authoritative missing-container response as absent', () => {
    expect(classifyDockerInspectStatus(1, 'Error: No such object: tau-sandbox-squad_x')).toBe('not_found')
    expect(classifyDockerInspectStatus(1, 'Cannot connect to the Docker daemon')).toBe('unknown')
  })
})

describe('classifyDockerContainerOwnership', () => {
  const name = 'tau-sandbox-agent_x'
  it('accepts exact current ownership and rejects a labeled neighbor', () => {
    expect(
      classifyDockerContainerOwnership(
        { Name: `/${name}`, Config: { Labels: { 'tau.managed': 'true', 'tau.sandbox-id': 'agent_x' } } },
        'agent_x',
        name
      )
    ).toBe('current')
    expect(
      classifyDockerContainerOwnership(
        { Name: `/${name}`, Config: { Labels: { 'tau.managed': 'true', 'tau.sandbox-id': 'neighbor' } } },
        'agent_x',
        name
      )
    ).toBe('unproven')
  })
  it('accepts legacy provenance only with exact name, spec, and workspace mount', () => {
    const legacy = {
      Name: `/${name}`,
      Config: { Labels: { 'tau.spec-hash': 'abc' } },
      Mounts: [{ Source: '/owned/workspace' }, { Source: '/neighbor' }],
    }
    expect(classifyDockerContainerOwnership(legacy, 'agent_x', name, '/owned/workspace')).toBe('legacy')
    expect(classifyDockerContainerOwnership(legacy, 'agent_x', name, '/different')).toBe('unproven')
  })
})
