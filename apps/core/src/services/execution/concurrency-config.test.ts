import { describe, it, expect, afterEach } from 'bun:test'
import {
  DEFAULT_PROVIDER_CONCURRENCY_LIMITS,
  resolveLimits,
  getLimit,
  type ConcurrencyLimits,
} from './concurrency-config'

describe('concurrency-config', () => {
  const originalEnv = process.env.PROVIDER_CONCURRENCY_LIMITS

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PROVIDER_CONCURRENCY_LIMITS
    else process.env.PROVIDER_CONCURRENCY_LIMITS = originalEnv
  })

  it('ships a zai default', () => {
    expect(DEFAULT_PROVIDER_CONCURRENCY_LIMITS.zai).toBe(10)
  })

  it('getLimit: model-specific overrides provider', () => {
    const limits: ConcurrencyLimits = { zai: 10, 'zai/glm-5.2': 5 }
    expect(getLimit(limits, 'zai', 'glm-5.2')).toBe(5)
    expect(getLimit(limits, 'zai', 'glm-5.1')).toBe(10)
  })

  it('getLimit: undefined when not configured (unlimited)', () => {
    expect(getLimit({ zai: 10 }, 'anthropic', 'claude-sonnet-4-5')).toBeUndefined()
  })

  it('resolveLimits: merges env JSON over defaults per-key', () => {
    process.env.PROVIDER_CONCURRENCY_LIMITS = '{"zai": 20, "openai-codex": 8}'
    const limits = resolveLimits()
    expect(limits.zai).toBe(20)
    expect(limits['openai-codex']).toBe(8)
  })

  it('resolveLimits: falls back to defaults on malformed env', () => {
    process.env.PROVIDER_CONCURRENCY_LIMITS = 'not json'
    const limits = resolveLimits()
    expect(limits.zai).toBe(DEFAULT_PROVIDER_CONCURRENCY_LIMITS.zai)
  })

  it('resolveLimits: ignores non-positive values in env', () => {
    process.env.PROVIDER_CONCURRENCY_LIMITS = '{"zai": 0, "openai-codex": -1}'
    const limits = resolveLimits()
    expect(limits.zai).toBe(DEFAULT_PROVIDER_CONCURRENCY_LIMITS.zai)
    expect(limits['openai-codex']).toBeUndefined()
  })
})
