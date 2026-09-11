import { describe, it, expect } from 'bun:test'
import { getProbe, registeredProbeProviders } from './index'

describe('provider health probe registry', () => {
  it('registers providers with token-free health probes', () => {
    expect(getProbe('openrouter')?.provider).toBe('openrouter')
    expect(getProbe('anthropic')?.provider).toBe('anthropic')
    expect(getProbe('zai')?.provider).toBe('zai')
    expect(registeredProbeProviders().sort()).toEqual(['anthropic', 'openrouter', 'zai'])
  })

  it('does not register openai-codex because it has no token-free health endpoint', () => {
    expect(getProbe('openai-codex')).toBeUndefined()
  })
})
