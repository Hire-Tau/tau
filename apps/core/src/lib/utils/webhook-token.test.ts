import { describe, it, expect } from 'bun:test'
import { generateWebhookToken, hashWebhookToken, verifyWebhookToken } from './webhook-token'

describe('webhook-token', () => {
  describe('generateWebhookToken', () => {
    it('generates a token with whsec_ prefix', () => {
      const token = generateWebhookToken()
      expect(token).toMatch(/^whsec_[a-f0-9]{64}$/)
    })

    it('generates unique tokens', () => {
      const token1 = generateWebhookToken()
      const token2 = generateWebhookToken()
      expect(token1).not.toBe(token2)
    })
  })

  describe('hashWebhookToken', () => {
    it('produces a 64-character hex hash', () => {
      const token = generateWebhookToken()
      const hash = hashWebhookToken(token)
      expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('produces consistent hashes for the same token', () => {
      const token = generateWebhookToken()
      const hash1 = hashWebhookToken(token)
      const hash2 = hashWebhookToken(token)
      expect(hash1).toBe(hash2)
    })

    it('produces different hashes for different tokens', () => {
      const token1 = generateWebhookToken()
      const token2 = generateWebhookToken()
      const hash1 = hashWebhookToken(token1)
      const hash2 = hashWebhookToken(token2)
      expect(hash1).not.toBe(hash2)
    })
  })

  describe('verifyWebhookToken', () => {
    it('returns true for matching token and hash', () => {
      const token = generateWebhookToken()
      const hash = hashWebhookToken(token)
      expect(verifyWebhookToken(token, hash)).toBe(true)
    })

    it('returns false for mismatched token', () => {
      const token1 = generateWebhookToken()
      const token2 = generateWebhookToken()
      const hash1 = hashWebhookToken(token1)
      expect(verifyWebhookToken(token2, hash1)).toBe(false)
    })

    it('returns false for tampered token', () => {
      const token = generateWebhookToken()
      const hash = hashWebhookToken(token)
      const replacement = token.endsWith('0') ? '1' : '0'
      const tamperedToken = token.slice(0, -1) + replacement
      expect(verifyWebhookToken(tamperedToken, hash)).toBe(false)
    })

    it('returns false for hash length mismatch', () => {
      const token = generateWebhookToken()
      expect(verifyWebhookToken(token, 'short')).toBe(false)
    })
  })
})
