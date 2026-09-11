import { describe, expect, test } from 'bun:test'
import { sanitizeProviderRecord } from './cause'

describe('sanitizeProviderRecord', () => {
  test.each([
    ['invalid-credential', 'Provider credentials are invalid.'],
    ['expired-oauth', 'Provider OAuth credentials expired or were revoked.'],
    ['plan-credit', 'Provider plan credits are unavailable.'],
    ['rate-limit', 'Provider rate limit is preventing requests.'],
    ['capacity', 'Provider capacity is unavailable.'],
    ['error', 'Provider requests are failing.'],
    ['network', 'Provider network requests are failing.'],
  ] as const)('projects %s to allowlisted copy without raw record text', (kind, summary) => {
    const result = sanitizeProviderRecord({ provider: 'openai-codex', kind })
    expect(result).toMatchObject({ kind, summary })
  })

  test('omits command remediation when provider identifier is unsafe', () => {
    expect(sanitizeProviderRecord({ provider: 'provider;rm', kind: 'invalid-credential' }).remediation).toBeUndefined()
  })
})
