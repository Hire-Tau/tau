import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { requirePeerSignature } from './require-peer-signature'
import { authzSentinel } from './authz-sentinel'
import { Peer } from '../entities/Peer'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem, signEnvelope } from '../services/amtp/crypto'

// Production-like app: sentinel wired exactly as in apps/core/src/index.ts, so a
// passing request must have set authzChecked, and a 401 must survive untouched.
function buildApp() {
  const app = new Hono()
  app.use('/api/*', authzSentinel)
  app.post('/api/test', requirePeerSignature, (c) =>
    c.json({
      peerInstanceId: c.get('peerInstanceId'),
      authzChecked: c.get('authzChecked'),
      raw: c.get('amtpRawBody'),
    })
  )
  return app
}

const app = buildApp()

const body = JSON.stringify({ hello: 'world', n: 1 })
const bytes = new TextEncoder().encode(body)

const activeKeys = generateInstanceKeyPair()
const disabledKeys = generateInstanceKeyPair()
const unknownKeys = generateInstanceKeyPair()
const activeInstanceId = instanceIdFromPublicKeyPem(activeKeys.publicKeyPem)
const disabledInstanceId = instanceIdFromPublicKeyPem(disabledKeys.publicKeyPem)
const unknownInstanceId = instanceIdFromPublicKeyPem(unknownKeys.publicKeyPem)

let active: Peer
let disabled: Peer

beforeAll(async () => {
  active = await Peer.create({
    localAlias: `peer-sig-active-${Date.now()}`,
    instanceId: activeInstanceId,
    baseUrl: 'https://active.example',
    publicKeyPem: activeKeys.publicKeyPem,
  })
  disabled = await Peer.create({
    localAlias: `peer-sig-disabled-${Date.now()}`,
    instanceId: disabledInstanceId,
    baseUrl: 'https://disabled.example',
    publicKeyPem: disabledKeys.publicKeyPem,
  })
  await Peer.update(disabled.id, { status: 'disabled' })
})

afterAll(async () => {
  await Peer.delete(active.id)
  await Peer.delete(disabled.id)
})

describe('requirePeerSignature', () => {
  test('valid signature → passes, sets peerInstanceId + raw body + authzChecked', async () => {
    const sig = signEnvelope(activeKeys.privateKeyPem, bytes)
    const res = await app.request('/api/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amtp-instance': activeInstanceId,
        'x-amtp-signature': sig,
      },
      body,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      peerInstanceId: activeInstanceId,
      authzChecked: true,
      raw: body,
    })
  })

  test('header lookup is case-insensitive', async () => {
    const sig = signEnvelope(activeKeys.privateKeyPem, bytes)
    const res = await app.request('/api/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Amtp-Instance': activeInstanceId,
        'X-Amtp-Signature': sig,
      },
      body,
    })
    expect(res.status).toBe(200)
  })

  test('bad signature → 401', async () => {
    // Signature forged with the wrong key for this peer.
    const sig = signEnvelope(unknownKeys.privateKeyPem, bytes)
    const res = await app.request('/api/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amtp-instance': activeInstanceId,
        'x-amtp-signature': sig,
      },
      body,
    })
    expect(res.status).toBe(401)
  })

  test('signature over different bytes → 401', async () => {
    const sig = signEnvelope(activeKeys.privateKeyPem, new TextEncoder().encode('{}'))
    const res = await app.request('/api/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amtp-instance': activeInstanceId,
        'x-amtp-signature': sig,
      },
      body,
    })
    expect(res.status).toBe(401)
  })

  test('disabled (non-active) peer → 401', async () => {
    const sig = signEnvelope(disabledKeys.privateKeyPem, bytes)
    const res = await app.request('/api/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amtp-instance': disabledInstanceId,
        'x-amtp-signature': sig,
      },
      body,
    })
    expect(res.status).toBe(401)
  })

  test('unknown peer → 401', async () => {
    const sig = signEnvelope(unknownKeys.privateKeyPem, bytes)
    const res = await app.request('/api/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amtp-instance': unknownInstanceId,
        'x-amtp-signature': sig,
      },
      body,
    })
    expect(res.status).toBe(401)
  })

  test('missing x-amtp-instance → 401', async () => {
    const sig = signEnvelope(activeKeys.privateKeyPem, bytes)
    const res = await app.request('/api/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amtp-signature': sig },
      body,
    })
    expect(res.status).toBe(401)
  })

  test('missing x-amtp-signature → 401', async () => {
    const res = await app.request('/api/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amtp-instance': activeInstanceId },
      body,
    })
    expect(res.status).toBe(401)
  })
})
