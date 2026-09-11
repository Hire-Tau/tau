import { describe, expect, test } from 'bun:test'
import {
  parseOAuthCredential,
  rotateOAuthCredential,
  serializeOAuthCredential,
  type OAuthCredentialBundleV1,
} from './credential-bundle'

const credential: OAuthCredentialBundleV1 = {
  version: 1,
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: '2026-08-29T01:00:00.000Z',
  tokenRevision: 1,
}

describe('OAuth credential bundle codec', () => {
  test('round-trips one canonical exact-key bundle', () => {
    const serialized = serializeOAuthCredential(credential)
    expect(serialized).toBe(
      '{"version":1,"accessToken":"access-token","refreshToken":"refresh-token","expiresAt":"2026-08-29T01:00:00.000Z","tokenRevision":1}'
    )
    expect(parseOAuthCredential(serialized)).toEqual(credential)
  })

  test('supports nullable refresh token and expiry without inventing values', () => {
    const value = { ...credential, refreshToken: null, expiresAt: null }
    expect(parseOAuthCredential(serializeOAuthCredential(value))).toEqual(value)
  })

  test.each([
    '{}',
    '{"version":1,"accessToken":"a","refreshToken":null,"expiresAt":null,"tokenRevision":1,"extra":true}',
    '{"version":1,"accessToken":"","refreshToken":null,"expiresAt":null,"tokenRevision":1}',
    `{"version":1,"accessToken":"${'a'.repeat(16_385)}","refreshToken":null,"expiresAt":null,"tokenRevision":1}`,
    '{"version":1,"accessToken":"a","refreshToken":"","expiresAt":null,"tokenRevision":1}',
    '{"version":1,"accessToken":"a","refreshToken":null,"expiresAt":"2026-08-29","tokenRevision":1}',
    '{"version":1,"accessToken":"a","refreshToken":null,"expiresAt":"2026-08-29T01:00:00+01:00","tokenRevision":1}',
    '{"version":1,"accessToken":"a","refreshToken":null,"expiresAt":null,"tokenRevision":0}',
    '{"version":1,"accessToken":"a","refreshToken":null,"expiresAt":null,"tokenRevision":1.5}',
  ])('rejects malformed or non-canonical input %#', (raw) => {
    expect(() => parseOAuthCredential(raw)).toThrow('Invalid OAuth credential bundle')
  })

  test('parser diagnostics never echo credential material', () => {
    const sentinel = 'TOKEN-SENTINEL'
    try {
      parseOAuthCredential(`{"version":1,"accessToken":"${sentinel}","refreshToken":null}`)
      throw new Error('expected parser failure')
    } catch (error) {
      expect(String(error)).not.toContain(sentinel)
    }
  })

  test('rotates the access and refresh pair with one monotonic revision', () => {
    expect(
      rotateOAuthCredential(credential, {
        accessToken: 'access-rotated',
        refreshToken: 'refresh-rotated',
        expiresAt: null,
      })
    ).toEqual({
      version: 1,
      accessToken: 'access-rotated',
      refreshToken: 'refresh-rotated',
      expiresAt: null,
      tokenRevision: 2,
    })
  })

  test('refuses revision overflow', () => {
    expect(() =>
      rotateOAuthCredential(
        { ...credential, tokenRevision: Number.MAX_SAFE_INTEGER },
        { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: null }
      )
    ).toThrow('OAuth credential revision exhausted')
  })
})
