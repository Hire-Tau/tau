import { describe, it, expect } from 'bun:test'
import { compareSensitivity, isAllowedBy, parseSensitivity } from './sensitivity'

describe('sensitivity', () => {
  it('orders public < internal < restricted < confidential', () => {
    expect(compareSensitivity('public', 'internal')).toBeLessThan(0)
    expect(compareSensitivity('internal', 'restricted')).toBeLessThan(0)
    expect(compareSensitivity('restricted', 'confidential')).toBeLessThan(0)
    expect(compareSensitivity('confidential', 'public')).toBeGreaterThan(0)
    expect(compareSensitivity('internal', 'internal')).toBe(0)
  })

  it('checks whether a document tier is allowed by a ceiling', () => {
    expect(isAllowedBy('public', 'internal')).toBe(true)
    expect(isAllowedBy('internal', 'internal')).toBe(true)
    expect(isAllowedBy('restricted', 'internal')).toBe(false)
    expect(isAllowedBy('confidential', 'restricted')).toBe(false)
    expect(isAllowedBy('confidential', undefined)).toBe(true)
  })

  it('parses valid tiers and defaults unknown values to internal', () => {
    expect(parseSensitivity('public')).toBe('public')
    expect(parseSensitivity('confidential')).toBe('confidential')
    expect(parseSensitivity(undefined)).toBe('internal')
    expect(parseSensitivity('nonsense')).toBe('internal')
    expect(parseSensitivity(42)).toBe('internal')
  })
})
