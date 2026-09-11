import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { db } from '../db'
import { agents } from '../db/schema'
import { Agent } from './Agent'
import { eq } from 'drizzle-orm'

describe('Agent federation columns', () => {
  const publishedId = crypto.randomUUID()
  const terminatedId = crypto.randomUUID()
  const updateTargetId = crypto.randomUUID()
  const publishedHandle = `pub-${crypto.randomUUID().slice(0, 8)}`
  const terminatedHandle = `term-${crypto.randomUUID().slice(0, 8)}`
  const updateTargetHandle = `upd-${crypto.randomUUID().slice(0, 8)}`
  const updatedHandle = `upd2-${crypto.randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    await db.insert(agents).values({
      id: publishedId,
      agentTypeId: 'manager',
      squadId: null,
      status: 'idle',
      amtpHandle: publishedHandle,
      identityPublicKey: 'pem-published',
      inboundOpen: true,
    })
    await db.insert(agents).values({
      id: terminatedId,
      agentTypeId: 'manager',
      squadId: null,
      status: 'terminated',
      amtpHandle: terminatedHandle,
      identityPublicKey: 'pem-terminated',
      terminatedAt: new Date(),
    })
    await db.insert(agents).values({
      id: updateTargetId,
      agentTypeId: 'manager',
      squadId: null,
      status: 'idle',
      amtpHandle: updateTargetHandle,
      identityPublicKey: 'pem-original',
      inboundOpen: true,
    })
  })

  afterAll(async () => {
    await db.delete(agents).where(eq(agents.id, publishedId))
    await db.delete(agents).where(eq(agents.id, terminatedId))
    await db.delete(agents).where(eq(agents.id, updateTargetId))
  })

  it('resolves a published agent by federation handle with the renamed key + inboundOpen', async () => {
    const agent = await Agent.findByFederationHandle(publishedHandle)
    expect(agent).not.toBeNull()
    expect(agent!.id).toBe(publishedId)
    expect(agent!.identityPublicKey).toBe('pem-published')
    expect(agent!.inboundOpen).toBe(true)
  })

  it('returns null for a terminated agent', async () => {
    expect(await Agent.findByFederationHandle(terminatedHandle)).toBeNull()
  })

  it('returns null for an unknown handle', async () => {
    expect(await Agent.findByFederationHandle('no-such-handle')).toBeNull()
  })

  it('exposes federation fields on Agent.find + toJson', async () => {
    const agent = await Agent.find(publishedId)
    expect(agent!.identityPublicKey).toBe('pem-published')
    expect(agent!.inboundOpen).toBe(true)
    const json = agent!.toJson()
    expect(json.amtpHandle).toBe(publishedHandle)
    expect(json.identityPublicKey).toBe('pem-published')
    expect(json.inboundOpen).toBe(true)
  })

  it('update() persists amtpHandle, identityPublicKey, and inboundOpen', async () => {
    const agent = await Agent.find(updateTargetId)
    await agent!.update({
      amtpHandle: updatedHandle,
      inboundOpen: false,
      identityPublicKey: 'pem-rotated',
    })
    const reloaded = await Agent.find(updateTargetId)
    expect(reloaded!.amtpHandle).toBe(updatedHandle)
    expect(reloaded!.inboundOpen).toBe(false)
    expect(reloaded!.identityPublicKey).toBe('pem-rotated')
    // findByFederationHandle also reflects the new handle
    expect(await Agent.findByFederationHandle(updatedHandle)).not.toBeNull()
    expect(await Agent.findByFederationHandle(updateTargetHandle)).toBeNull()
  })
})
