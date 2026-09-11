import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { squads, squadMemoryGrants } from '../db/schema'
import { SquadMemoryGrant, type GrantPolicy } from './SquadMemoryGrant'

describe('SquadMemoryGrant', () => {
  const sourceSquadId = crypto.randomUUID()
  const granteeSquadId = crypto.randomUUID()

  beforeAll(async () => {
    await db.insert(squads).values([
      { id: sourceSquadId, name: 'Source', purpose: 'Test source', status: 'active' },
      { id: granteeSquadId, name: 'Grantee', purpose: 'Test grantee', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.delete(squadMemoryGrants).where(eq(squadMemoryGrants.sourceSquadId, sourceSquadId))
    await db.delete(squads).where(eq(squads.id, sourceSquadId))
    await db.delete(squads).where(eq(squads.id, granteeSquadId))
  })

  beforeEach(async () => {
    await db.delete(squadMemoryGrants).where(eq(squadMemoryGrants.sourceSquadId, sourceSquadId))
  })

  it('stores a policy and returns an instance', async () => {
    const policy: GrantPolicy = {
      read: { sourceTypes: ['memory_file'], paths: ['/memory/company/**'], sensitivity: 'internal' },
    }
    const grant = await SquadMemoryGrant.create({ sourceSquadId, granteeSquadId, policy })
    expect(grant.sourceSquadId).toBe(sourceSquadId)
    expect(grant.granteeSquadId).toBe(granteeSquadId)
    expect(grant.policy.read?.paths).toEqual(['/memory/company/**'])
  })

  it('finds only non-expired grants for a grantee', async () => {
    await SquadMemoryGrant.create({ sourceSquadId, granteeSquadId, policy: { read: {} } })
    await SquadMemoryGrant.create({
      sourceSquadId,
      granteeSquadId,
      policy: { read: {} },
      expiresAt: new Date(Date.now() + 60_000),
    })
    await SquadMemoryGrant.create({
      sourceSquadId,
      granteeSquadId,
      policy: { read: {} },
      expiresAt: new Date(Date.now() - 1000),
    })

    const active = await SquadMemoryGrant.findActiveByGrantee(granteeSquadId)
    expect(active).toHaveLength(2)
    for (const grant of active) {
      if (grant.expiresAt) expect(grant.expiresAt.getTime()).toBeGreaterThan(Date.now())
    }
  })

  it('returns empty when there are no grants and deletes grants', async () => {
    expect(await SquadMemoryGrant.findActiveByGrantee(crypto.randomUUID())).toEqual([])
    const grant = await SquadMemoryGrant.create({ sourceSquadId, granteeSquadId, policy: { read: {} } })
    await grant.delete()
    expect(await SquadMemoryGrant.findActiveByGrantee(granteeSquadId)).toEqual([])
  })

  it('rejects source-specific grant filters for unknown source types', async () => {
    await expect(
      SquadMemoryGrant.create({
        sourceSquadId,
        granteeSquadId,
        policy: { read: { sourceFilters: { unknown_type: {} } } },
      })
    ).rejects.toThrow('unknown source filter source type: unknown_type')
  })
})
