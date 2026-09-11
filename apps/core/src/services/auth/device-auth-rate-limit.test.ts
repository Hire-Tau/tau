import { describe, expect, it } from 'bun:test'
import { FixedWindowLimiter, MAX_LIMITER_KEYS } from './device-auth-rate-limit'

describe('device authorization start limiter', () => {
  it('limits each key within a window and resets afterward', () => {
    let now = 0
    const limiter = new FixedWindowLimiter(() => now)
    expect(Array.from({ length: 10 }, () => limiter.take('a', 10, 60_000)).every(Boolean)).toBe(true)
    expect(limiter.take('a', 10, 60_000)).toBe(false)
    expect(limiter.take('b', 10, 60_000)).toBe(true)
    now = 60_001
    expect(limiter.take('a', 10, 60_000)).toBe(true)
  })

  it('stays hard-bounded when distinct keys exceed the cap before expiry', () => {
    const limiter = new FixedWindowLimiter(() => 0)

    const accepted = Array.from({ length: MAX_LIMITER_KEYS + 250 }, (_, index) =>
      limiter.take(`client-${index}`, 10, 60_000)
    )

    expect(accepted.every(Boolean)).toBe(true)
    expect(limiter.size).toBe(MAX_LIMITER_KEYS)
  })
})
