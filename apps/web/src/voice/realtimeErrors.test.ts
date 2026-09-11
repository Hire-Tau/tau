import { describe, expect, test } from 'bun:test'
import { parseRealtimeRateLimitRetryDelay } from './realtimeErrors'

describe('parseRealtimeRateLimitRetryDelay', () => {
  test('parses millisecond retry delay from rate limit message', () => {
    const retry = parseRealtimeRateLimitRetryDelay({
      code: 'rate_limit_exceeded',
      message: 'Please try again in 627ms.',
    })

    expect(retry?.delayMs).toBe(627)
  })

  test('parses second retry delay from rate limit message', () => {
    const retry = parseRealtimeRateLimitRetryDelay({
      code: 'rate_limit_exceeded',
      message: 'Please try again in 1.5s.',
    })

    expect(retry?.delayMs).toBe(1500)
  })

  test('ignores non-rate-limit errors', () => {
    expect(parseRealtimeRateLimitRetryDelay({ code: 'server_error', message: 'oops' })).toBeNull()
  })
})
