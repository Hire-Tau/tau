import { describe, test, expect } from 'bun:test'
import { db, instanceIdentity } from '../db'
import { InstanceIdentity } from './InstanceIdentity'

describe('InstanceIdentity', () => {
  test('getOrCreate generates one stable singleton', async () => {
    await db.delete(instanceIdentity)
    const a = await InstanceIdentity.getOrCreate()
    const b = await InstanceIdentity.getOrCreate()
    expect(a.instanceId).toBe(b.instanceId)
    expect(a.publicKeyPem).toContain('BEGIN PUBLIC KEY')
    const rows = await db.select().from(instanceIdentity)
    expect(rows.length).toBe(1)
  })

  test('getPublic exposes only non-secret fields', async () => {
    const pub = await InstanceIdentity.getPublic()
    expect(pub.instanceId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pub.publicKeyPem).toContain('BEGIN PUBLIC KEY')
    expect((pub as Record<string, unknown>).privateKeyPem).toBeUndefined()
  })
})
