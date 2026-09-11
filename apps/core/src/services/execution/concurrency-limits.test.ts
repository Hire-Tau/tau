import { describe, it, expect, beforeEach } from 'bun:test'
import { ConcurrencyLimiter, parseConcurrencyKey, type ConcurrencyLimits } from './concurrency-limits'

describe('ConcurrencyLimiter', () => {
  let limiter: ConcurrencyLimiter
  const limits: ConcurrencyLimits = { zai: 2, 'anthropic/claude-sonnet-4-5': 1 }

  beforeEach(() => {
    limiter = new ConcurrencyLimiter(limits)
  })

  describe('hasCapacity / tryAcquire / release', () => {
    it('tryAcquire succeeds up to the limit then fails', () => {
      expect(limiter.tryAcquire('e1', 'zai', 'glm-5.2')).toBe(true)
      expect(limiter.tryAcquire('e2', 'zai', 'glm-5.2')).toBe(true)
      expect(limiter.tryAcquire('e3', 'zai', 'glm-5.2')).toBe(false)
      expect(limiter.getInFlight('zai')).toBe(2)
    })

    it('release frees a slot and unblocks the next acquire', () => {
      limiter.tryAcquire('e1', 'zai')
      limiter.tryAcquire('e2', 'zai')
      expect(limiter.tryAcquire('e3', 'zai')).toBe(false)
      limiter.release('e1')
      expect(limiter.tryAcquire('e3', 'zai')).toBe(true)
    })

    it('unlimited provider always acquires but is not counted', () => {
      expect(limiter.tryAcquire('e1', 'openai-codex', 'gpt-5')).toBe(true)
      expect(limiter.tryAcquire('e2', 'openai-codex', 'gpt-5')).toBe(true)
      expect(limiter.getInFlight('openai-codex')).toBe(0)
      expect(() => limiter.release('e1')).not.toThrow()
      expect(limiter.getInFlight('openai-codex')).toBe(0)
    })

    it('release is idempotent and safe for unknown executionIds', () => {
      expect(() => limiter.release('never-acquired')).not.toThrow()
      limiter.tryAcquire('e1', 'zai')
      limiter.release('e1')
      limiter.release('e1')
      expect(limiter.getInFlight('zai')).toBe(0)
    })

    it('model-specific limit is independent of the provider pool', () => {
      expect(limiter.tryAcquire('e1', 'anthropic', 'claude-sonnet-4-5')).toBe(true)
      expect(limiter.tryAcquire('e2', 'anthropic', 'claude-sonnet-4-5')).toBe(false)
      expect(limiter.tryAcquire('e3', 'anthropic', 'claude-haiku')).toBe(true)
    })
  })

  describe('reassign (failover / reconciliation)', () => {
    it('moves the count from old provider to new provider', () => {
      limiter.tryAcquire('e1', 'zai', 'glm-5.2')
      expect(limiter.getInFlight('zai')).toBe(1)
      limiter.reassign('e1', 'anthropic', 'claude-sonnet-4-5')
      expect(limiter.getInFlight('zai')).toBe(0)
      expect(limiter.getInFlight('anthropic', 'claude-sonnet-4-5')).toBe(1)
    })

    it('reassign to the same key is a no-op', () => {
      limiter.tryAcquire('e1', 'zai', 'glm-5.2')
      const before = limiter.getInFlight('zai')
      limiter.reassign('e1', 'zai', 'glm-5.2')
      expect(limiter.getInFlight('zai')).toBe(before)
    })

    it('reassign can force over the limit (runtime failover must proceed)', () => {
      limiter.tryAcquire('e1', 'zai')
      limiter.tryAcquire('e2', 'zai')
      limiter.reassign('e1', 'zai', 'glm-5.2')
      expect(limiter.getInFlight('zai')).toBe(2)
      expect(limiter.hasCapacity('zai')).toBe(false)
    })

    it('reassign from unlimited to limited acquires the limited count', () => {
      limiter.tryAcquire('e1', 'openai-codex', 'gpt-5')
      limiter.reassign('e1', 'zai', 'glm-5.2')
      expect(limiter.getInFlight('zai')).toBe(1)
    })
  })

  describe('reset', () => {
    it('clears in-flight counts and execution slot tracking without changing limits', () => {
      expect(limiter.tryAcquire('e1', 'zai', 'glm-5.2')).toBe(true)
      expect(limiter.getInFlight('zai')).toBe(1)

      limiter.reset()

      expect(limiter.getInFlight('zai')).toBe(0)
      expect(limiter.tryAcquire('e2', 'zai', 'glm-5.2')).toBe(true)
      expect(limiter.getLimit('zai')).toBe(2)
    })
  })

  describe('snapshot (observability)', () => {
    it('returns {inFlight, limit} per configured provider', () => {
      limiter.tryAcquire('e1', 'zai')
      const snap = limiter.snapshot()
      expect(snap.zai).toEqual({ inFlight: 1, limit: 2 })
      expect(snap.openai).toBeUndefined()
    })
  })

  describe('parseConcurrencyKey', () => {
    it('splits provider/modelId', () => {
      expect(parseConcurrencyKey('zai/glm-5.2')).toEqual({ provider: 'zai', modelId: 'glm-5.2' })
    })
    it('returns bare provider when no modelId', () => {
      expect(parseConcurrencyKey('zai')).toEqual({ provider: 'zai', modelId: undefined })
    })
  })
})
