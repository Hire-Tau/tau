import { describe, test, expect } from 'bun:test'
import { parseAmtpAddress, formatAmtpAddress } from './address'

describe('federation address', () => {
  test('parses a well-formed amtp:// address', () => {
    expect(parseAmtpAddress('amtp://abc123/alice')).toEqual({
      instanceId: 'abc123',
      handle: 'alice',
    })
  })

  test('format then parse roundtrips', () => {
    const addr = formatAmtpAddress('inst-9', 'bob')
    expect(addr).toBe('amtp://inst-9/bob')
    expect(parseAmtpAddress(addr)).toEqual({ instanceId: 'inst-9', handle: 'bob' })
  })

  test('parses a base64url instance id with a plain handle', () => {
    const id = 'AbC_dEf-123456789012345678901234567890123456'
    expect(parseAmtpAddress(`amtp://${id}/manager`)).toEqual({
      instanceId: id,
      handle: 'manager',
    })
  })

  test('returns null for malformed addresses', () => {
    expect(parseAmtpAddress('http://x/y')).toBeNull() // wrong scheme
    expect(parseAmtpAddress('amtp://onlyinstance')).toBeNull() // no handle segment
    expect(parseAmtpAddress('amtp:///handle')).toBeNull() // empty instance id
    expect(parseAmtpAddress('amtp://inst/')).toBeNull() // empty handle
    expect(parseAmtpAddress('amtp://inst/a/b')).toBeNull() // too many segments
    expect(parseAmtpAddress('')).toBeNull()
    expect(parseAmtpAddress('amtp://')).toBeNull()
    // whitespace in segments must be rejected (misrouting vector)
    expect(parseAmtpAddress('amtp://in st/handle')).toBeNull() // space in instanceId
    expect(parseAmtpAddress('amtp://inst/han dle')).toBeNull() // space in handle
    expect(parseAmtpAddress('amtp://inst/han\thandle')).toBeNull() // tab in handle
    expect(parseAmtpAddress('amtp://inst/han\ndle')).toBeNull() // newline in handle
  })

  test('parse then format roundtrips (reverse direction)', () => {
    const addr = 'amtp://abc123/alice'
    const parsed = parseAmtpAddress(addr)!
    expect(formatAmtpAddress(parsed.instanceId, parsed.handle)).toBe(addr)
  })
})
