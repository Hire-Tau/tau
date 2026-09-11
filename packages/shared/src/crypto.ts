import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns { encrypted, iv } as hex strings.
 */
export function encrypt(plaintext: string, key: Buffer): { encrypted: string; iv: string } {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return {
    encrypted: encrypted.toString('hex'),
    iv: iv.toString('hex'),
  }
}

/**
 * Decrypt an AES-256-GCM encrypted string.
 * Expects hex-encoded encrypted data (ciphertext + auth tag) and iv.
 */
export function decrypt(encryptedHex: string, ivHex: string, key: Buffer): string {
  const iv = Buffer.from(ivHex, 'hex')
  const data = Buffer.from(encryptedHex, 'hex')

  // Last 16 bytes are the auth tag
  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH)
  const ciphertext = data.subarray(0, data.length - AUTH_TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  decipher.setAuthTag(authTag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}
