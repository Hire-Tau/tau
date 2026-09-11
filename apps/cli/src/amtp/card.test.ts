import { describe, test, expect } from 'bun:test'
import { generateKeyPairSync } from 'crypto'
import { verifyAgentCard } from 'amtp-protocol'
import { buildSignedCardBody } from './card'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pub = publicKey.export({ type: 'spki', format: 'pem' }) as string

describe('buildSignedCardBody', () => {
  test('produces a cardSig that verifies and binds instanceId/handle/card', () => {
    const signed = buildSignedCardBody({
      instanceId: 'inst-1',
      handle: 'alice',
      name: 'Alice',
      description: 'A helpful agent',
      privateKeyPem: priv,
    })
    expect(verifyAgentCard(pub, signed)).toBe(true)
    expect(signed.v).toBe(1)
    expect(signed.instanceId).toBe('inst-1')
    expect(signed.handle).toBe('alice')
    expect(signed.card).toEqual({ name: 'Alice', description: 'A helpful agent' })
  })

  test('tampering with instanceId/handle/card invalidates the signature', () => {
    const signed = buildSignedCardBody({
      instanceId: 'inst-1',
      handle: 'alice',
      name: 'Alice',
      privateKeyPem: priv,
    })
    expect(verifyAgentCard(pub, { ...signed, handle: 'mallory' })).toBe(false)
    expect(verifyAgentCard(pub, { ...signed, instanceId: 'other-instance' })).toBe(false)
    expect(verifyAgentCard(pub, { ...signed, card: { ...signed.card, name: 'Evil' } })).toBe(false)
  })

  test('omits absent name/description/extensions from the card', () => {
    const signed = buildSignedCardBody({
      instanceId: 'inst-1',
      handle: 'bob',
      privateKeyPem: priv,
    })
    expect(signed.card).toEqual({})
    expect(verifyAgentCard(pub, signed)).toBe(true)
  })

  test('omits an empty extensions object; includes a populated one', () => {
    const withExt = buildSignedCardBody({
      instanceId: 'inst-1',
      handle: 'carol',
      extensions: { foo: 'bar' },
      privateKeyPem: priv,
    })
    expect(withExt.card.extensions).toEqual({ foo: 'bar' })
    expect(verifyAgentCard(pub, withExt)).toBe(true)

    const noExt = buildSignedCardBody({
      instanceId: 'inst-1',
      handle: 'carol',
      extensions: {},
      privateKeyPem: priv,
    })
    expect(noExt.card.extensions).toBeUndefined()
  })
})
