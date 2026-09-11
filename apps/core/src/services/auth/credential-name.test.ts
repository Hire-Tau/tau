import { describe, expect, it } from 'bun:test'
import {
  MAX_CREDENTIAL_NAME_LENGTH,
  defaultCredentialName,
  normalizeCredentialName,
  resolveCredentialName,
} from './credential-name'

describe('normalizeCredentialName', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeCredentialName('  YubiKey  ')).toBe('YubiKey')
  })

  it('treats blank and absent alike as "no name given"', () => {
    expect(normalizeCredentialName(undefined)).toBeUndefined()
    expect(normalizeCredentialName('')).toBeUndefined()
    expect(normalizeCredentialName('   ')).toBeUndefined()
  })

  it('truncates rather than rejects — the credential must still be storable', () => {
    const long = 'x'.repeat(MAX_CREDENTIAL_NAME_LENGTH + 40)
    const normalized = normalizeCredentialName(long)
    expect(normalized).toHaveLength(MAX_CREDENTIAL_NAME_LENGTH)
  })

  it('leaves a name exactly at the bound untouched', () => {
    const exact = 'y'.repeat(MAX_CREDENTIAL_NAME_LENGTH)
    expect(normalizeCredentialName(exact)).toBe(exact)
  })
})

describe('defaultCredentialName', () => {
  it('names the platform the passkey was created on', () => {
    expect(defaultCredentialName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('Passkey on iPhone')
    expect(defaultCredentialName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Passkey on Mac')
    expect(defaultCredentialName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Passkey on Windows')
    expect(defaultCredentialName('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Passkey on Linux')
  })

  // The probe order is load-bearing, so both overlaps are pinned: an iPad in
  // desktop mode says "Macintosh", and every Android UA also says "Linux".
  it('prefers the specific platform where User-Agent strings overlap', () => {
    expect(defaultCredentialName('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('Passkey on iPad')
    expect(defaultCredentialName('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('Passkey on Android')
  })

  it('falls back to a bare label when the platform is unknown or absent', () => {
    expect(defaultCredentialName(undefined)).toBe('Passkey')
    expect(defaultCredentialName('')).toBe('Passkey')
    expect(defaultCredentialName('some-cli/1.0')).toBe('Passkey')
  })
})

describe('resolveCredentialName', () => {
  it('prefers what the user typed', () => {
    expect(resolveCredentialName('MacBook Touch ID', 'Mozilla/5.0 (Windows NT 10.0)')).toBe('MacBook Touch ID')
  })

  it('falls back to the device-derived default when the field was left blank', () => {
    expect(resolveCredentialName('   ', 'Mozilla/5.0 (Windows NT 10.0)')).toBe('Passkey on Windows')
    expect(resolveCredentialName(undefined, undefined)).toBe('Passkey')
  })
})
