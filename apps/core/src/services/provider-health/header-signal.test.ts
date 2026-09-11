import { describe, it, expect } from 'bun:test'
import { classifyResponseHeaders } from './header-signal'

describe('classifyResponseHeaders', () => {
  it('returns null for a healthy 200 with no rate-limit headers', () => {
    expect(classifyResponseHeaders(200, {})).toBeNull()
  })

  it('classifies a 429 as rate-limit exhaustion', () => {
    const r = classifyResponseHeaders(429, {})
    expect(r).not.toBeNull()
    expect(r!.reason).toBe('rate-limit')
    expect(r!.exhausted).toBe(true)
    expect(r!.status).toBe(429)
  })

  it('honors a retry-after header (seconds) as retryAt', () => {
    const now = Date.now()
    const r = classifyResponseHeaders(429, { 'retry-after': '30' })
    expect(r).not.toBeNull()
    expect(r!.reason).toBe('rate-limit')
    expect(r!.retryAt!).toBeGreaterThan(now + 29_000)
    expect(r!.retryAt!).toBeLessThan(now + 31_000)
  })

  it('honors a retry-after header (HTTP date)', () => {
    const future = new Date(Date.now() + 60_000).toUTCString()
    const r = classifyResponseHeaders(429, { 'retry-after': future })
    expect(r).not.toBeNull()
    expect(r!.reason).toBe('rate-limit')
    expect(r!.retryAt).toBeGreaterThan(Date.now())
  })

  it('classifies near-zero remaining on a 2xx as rate-limit (proactive)', () => {
    const r = classifyResponseHeaders(200, { 'x-ratelimit-remaining': '0' })
    expect(r).not.toBeNull()
    expect(r!.reason).toBe('rate-limit')
  })

  it('normalizes header names case-insensitively', () => {
    const r = classifyResponseHeaders(200, { 'X-RateLimit-Remaining': '0' })
    expect(r).not.toBeNull()
    expect(r!.reason).toBe('rate-limit')
  })

  it('treats a 402 status as plan-credit exhaustion', () => {
    const r = classifyResponseHeaders(402, {})
    expect(r).not.toBeNull()
    expect(r!.reason).toBe('plan-credit')
  })

  it('ignores remaining > 0 on a 2xx', () => {
    expect(classifyResponseHeaders(200, { 'x-ratelimit-remaining': '100' })).toBeNull()
  })

  it('returns null for 5xx (capacity surfaces via settled-error path)', () => {
    expect(classifyResponseHeaders(503, {})).toBeNull()
  })

  it('honors ratelimit-reset header when retry-after is absent', () => {
    const future = new Date(Date.now() + 90_000).toUTCString()
    const r = classifyResponseHeaders(429, { 'ratelimit-reset': future })
    expect(r).not.toBeNull()
    expect(r!.reason).toBe('rate-limit')
    expect(r!.retryAt).toBeGreaterThan(Date.now())
  })

  it('detects anthropic-ratelimit-requests-remaining near-zero', () => {
    const r = classifyResponseHeaders(200, { 'anthropic-ratelimit-requests-remaining': '0' })
    expect(r).not.toBeNull()
    expect(r!.reason).toBe('rate-limit')
  })

  it('returns null for a 200 with no relevant headers', () => {
    expect(classifyResponseHeaders(200, { 'content-type': 'application/json' })).toBeNull()
  })
})
