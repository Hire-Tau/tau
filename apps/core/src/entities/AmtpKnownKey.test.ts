import { describe, test, expect, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { amtpKnownKeys } from '../db/schema'
import { AmtpKnownKey } from './AmtpKnownKey'

const peer = `peer-${crypto.randomUUID().slice(0, 8)}`

afterEach(async () => {
  await db.delete(amtpKnownKeys).where(eq(amtpKnownKeys.peerInstanceId, peer))
})

describe('AmtpKnownKey', () => {
  test('getPin returns null before first contact', async () => {
    expect(await AmtpKnownKey.getPin(peer, 'alice')).toBeNull()
  })

  test('recordPinIfNew pins the first key and getPin returns it', async () => {
    const pinned = await AmtpKnownKey.recordPinIfNew(peer, 'alice', 'KEY-1')
    expect(pinned).toBe('KEY-1')
    expect(await AmtpKnownKey.getPin(peer, 'alice')).toBe('KEY-1')
  })

  test('recordPinIfNew keeps the FIRST key on conflict (returns existing, not the new one)', async () => {
    await AmtpKnownKey.recordPinIfNew(peer, 'alice', 'KEY-1')
    const effective = await AmtpKnownKey.recordPinIfNew(peer, 'alice', 'KEY-2')
    expect(effective).toBe('KEY-1')
    expect(await AmtpKnownKey.getPin(peer, 'alice')).toBe('KEY-1')
  })

  test('pins are scoped per (peer, handle)', async () => {
    await AmtpKnownKey.recordPinIfNew(peer, 'alice', 'KEY-A')
    await AmtpKnownKey.recordPinIfNew(peer, 'bob', 'KEY-B')
    expect(await AmtpKnownKey.getPin(peer, 'bob')).toBe('KEY-B')
  })
})
