import { describe, test, expect, beforeEach } from 'bun:test'
import { db, peers } from '../db'
import { Peer, LocalPeerResolver } from './Peer'

beforeEach(async () => {
  await db.delete(peers)
})

const sample = {
  localAlias: 'acme',
  instanceId: 'acme-instance-id-fingerprint-000000000000000',
  baseUrl: 'https://acme.example/api',
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
}

describe('Peer', () => {
  test('create + list + findByInstanceId', async () => {
    const p = await Peer.create(sample)
    expect(p.status).toBe('active')
    expect((await Peer.list()).map((x) => x.id)).toEqual([p.id])
    expect((await Peer.findByInstanceId(sample.instanceId))?.id).toBe(p.id)
  })

  test('update status and delete', async () => {
    const p = await Peer.create(sample)
    const updated = await Peer.update(p.id, { status: 'disabled' })
    expect(updated?.status).toBe('disabled')
    await Peer.delete(p.id)
    expect(await Peer.findById(p.id)).toBeNull()
  })

  test('LocalPeerResolver resolves by instanceId, null when unknown', async () => {
    await Peer.create(sample)
    const resolver = new LocalPeerResolver()
    const r = await resolver.resolve(sample.instanceId)
    expect(r).toEqual({ baseUrl: sample.baseUrl, publicKeyPem: sample.publicKeyPem, status: 'active' })
    expect(await resolver.resolve('nope')).toBeNull()
  })
})
