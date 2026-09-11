import { describe, test, expect } from 'bun:test'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem, signEnvelope, verifyEnvelope } from './crypto'

describe('federation crypto', () => {
  test('generates an Ed25519 PEM keypair', () => {
    const { publicKeyPem, privateKeyPem } = generateInstanceKeyPair()
    expect(publicKeyPem).toContain('BEGIN PUBLIC KEY')
    expect(privateKeyPem).toContain('BEGIN PRIVATE KEY')
  })

  test('instanceId is a stable base64url fingerprint of the public key', () => {
    const { publicKeyPem } = generateInstanceKeyPair()
    const a = instanceIdFromPublicKeyPem(publicKeyPem)
    const b = instanceIdFromPublicKeyPem(publicKeyPem)
    expect(a).toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/) // base64url sha256, no padding
  })

  test('different keys yield different instance ids', () => {
    const x = instanceIdFromPublicKeyPem(generateInstanceKeyPair().publicKeyPem)
    const y = instanceIdFromPublicKeyPem(generateInstanceKeyPair().publicKeyPem)
    expect(x).not.toBe(y)
  })
})

describe('signEnvelope/verifyEnvelope', () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, id: 'nonce-1', content: 'hello peer' }))

  test('sign -> verify roundtrip succeeds', () => {
    const { publicKeyPem, privateKeyPem } = generateInstanceKeyPair()
    const sig = signEnvelope(privateKeyPem, bytes)
    expect(typeof sig).toBe('string')
    // base64 (with padding) signature characters only
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(verifyEnvelope(publicKeyPem, bytes, sig)).toBe(true)
  })

  test('tampered bytes fail verification', () => {
    const { publicKeyPem, privateKeyPem } = generateInstanceKeyPair()
    const sig = signEnvelope(privateKeyPem, bytes)
    const tampered = new TextEncoder().encode(JSON.stringify({ v: 1, id: 'nonce-1', content: 'hello attacker' }))
    expect(verifyEnvelope(publicKeyPem, tampered, sig)).toBe(false)
  })

  test('wrong key fails verification', () => {
    const { privateKeyPem } = generateInstanceKeyPair()
    const other = generateInstanceKeyPair()
    const sig = signEnvelope(privateKeyPem, bytes)
    expect(verifyEnvelope(other.publicKeyPem, bytes, sig)).toBe(false)
  })

  test('malformed signature returns false (does not throw)', () => {
    const { publicKeyPem } = generateInstanceKeyPair()
    expect(verifyEnvelope(publicKeyPem, bytes, 'not-base64-$$$')).toBe(false)
    expect(verifyEnvelope(publicKeyPem, bytes, '')).toBe(false)
  })

  test('malformed public key returns false (does not throw)', () => {
    const { privateKeyPem } = generateInstanceKeyPair()
    const sig = signEnvelope(privateKeyPem, bytes)
    expect(verifyEnvelope('-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----', bytes, sig)).toBe(false)
  })
})
