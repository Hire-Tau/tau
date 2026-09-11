import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import { squadMemoryGrants, squads } from '../../../db/schema'
import { SquadMemoryGrant } from '../../../entities/SquadMemoryGrant'
import type { MemorySourceAdapter } from '../sources/adapter'
import { expandReadScope, type AdapterLookup } from './scope-expander'

function fakeAdapter(
  sourceType: string,
  validateGrantFilter?: (filter: unknown) => string[] | null
): MemorySourceAdapter {
  return {
    sourceType,
    capabilities: { all: new Set(), has: () => false },
    defaultSensitivity: 'internal',
    list: async () => [],
    fetch: async () => null,
    index: async () => ({ sourceType, sourceId: 'fake', success: true, chunksCreated: 0, linksCreated: 0 }),
    indexAll: async () => [],
    exists: async () => false,
    remove: async () => {},
    reconcile: async () => ({ removed: 0 }),
    validateGrantFilter,
  }
}

function adapterLookup(adapters: MemorySourceAdapter[]): AdapterLookup {
  const byType = new Map(adapters.map((adapter) => [adapter.sourceType, adapter]))
  return { getAdapter: (sourceType: string) => byType.get(sourceType) }
}

describe('expandReadScope', () => {
  const callerSquadId = crypto.randomUUID()
  const sourceSquadId = crypto.randomUUID()

  beforeAll(async () => {
    await db.insert(squads).values([
      { id: callerSquadId, name: 'Caller', purpose: 'Test', status: 'active' },
      { id: sourceSquadId, name: 'Source', purpose: 'Test', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.delete(squadMemoryGrants).where(eq(squadMemoryGrants.granteeSquadId, callerSquadId))
    await db.delete(squads).where(eq(squads.id, sourceSquadId))
    await db.delete(squads).where(eq(squads.id, callerSquadId))
  })

  beforeEach(async () => {
    await db.delete(squadMemoryGrants).where(eq(squadMemoryGrants.granteeSquadId, callerSquadId))
  })

  it('returns only the caller squad with requested filters when no grants exist', async () => {
    const scopes = await expandReadScope(callerSquadId, {
      sourceTypes: ['memory_file'],
      paths: ['/memory/decisions/**'],
    })
    expect(scopes).toEqual([
      {
        squadId: callerSquadId,
        isOwn: true,
        filters: { sourceTypes: ['memory_file'], paths: ['/memory/decisions/**'] },
      },
    ])
  })

  it('includes active granted source scopes with policy filters', async () => {
    await SquadMemoryGrant.create({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { sourceTypes: ['memory_file'], paths: ['/memory/company/**'], sensitivity: 'internal' } },
    })

    const scopes = await expandReadScope(callerSquadId, {})
    expect(scopes).toHaveLength(2)
    expect(scopes.find((s) => !s.isOwn)).toEqual({
      squadId: sourceSquadId,
      isOwn: false,
      filters: { sourceTypes: ['memory_file'], paths: ['/memory/company/**'], sensitivityCeiling: 'internal' },
    })
  })

  it('intersects source types and narrows path/sensitivity with caller request', async () => {
    await SquadMemoryGrant.create({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: {
        read: {
          sourceTypes: ['memory_file', 'agent_thread'],
          paths: ['/memory/company/**'],
          sensitivity: 'restricted',
        },
      },
    })

    const scopes = await expandReadScope(callerSquadId, {
      sourceTypes: ['memory_file'],
      paths: ['/memory/company/decisions/**'],
      sensitivity: 'internal',
    })
    const granted = scopes.find((s) => !s.isOwn)!
    expect(granted.filters).toEqual({
      sourceTypes: ['memory_file'],
      paths: ['/memory/company/decisions/**'],
      sensitivityCeiling: 'internal',
    })
  })

  it('excludes requested grant paths that are not covered by grant paths', async () => {
    await SquadMemoryGrant.create({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { paths: ['/memory/company/**'] } },
    })

    const unrelated = await expandReadScope(callerSquadId, { paths: ['/memory/secrets/**'] })
    expect(unrelated.filter((s) => !s.isOwn)).toHaveLength(0)

    const mixed = await expandReadScope(callerSquadId, {
      paths: ['/memory/company/decisions/**', '/memory/secrets/**'],
    })
    expect(mixed.find((s) => !s.isOwn)?.filters.paths).toEqual(['/memory/company/decisions/**'])
  })

  it('fails closed for expired grants, empty intersections, and malformed policies', async () => {
    await SquadMemoryGrant.create({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { sourceTypes: ['memory_file'] } },
      expiresAt: new Date(Date.now() - 1000),
    })
    await SquadMemoryGrant.create({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { sourceTypes: ['agent_thread'] } },
    })
    await db.insert(squadMemoryGrants).values({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { sensitivity: 'not-real' } },
    })

    const scopes = await expandReadScope(callerSquadId, { sourceTypes: ['memory_file'] })
    expect(scopes.filter((s) => !s.isOwn)).toHaveLength(0)
  })

  it('honors explicit source squad filters without expanding access', async () => {
    await SquadMemoryGrant.create({ sourceSquadId, granteeSquadId: callerSquadId, policy: { read: {} } })
    expect(await expandReadScope(callerSquadId, { sourceSquadIds: [callerSquadId] })).toHaveLength(1)
    const onlyGranted = await expandReadScope(callerSquadId, { sourceSquadIds: [sourceSquadId] })
    expect(onlyGranted).toHaveLength(1)
    expect(onlyGranted[0].squadId).toBe(sourceSquadId)
  })

  it('passes validated source-specific filters through granted scopes', async () => {
    await db.insert(squadMemoryGrants).values({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { sourceTypes: ['fake_source'], sourceFilters: { fake_source: { channelIds: ['C123'] } } } },
    })

    const scopes = await expandReadScope(
      callerSquadId,
      { sourceTypes: ['fake_source'] },
      adapterLookup([fakeAdapter('fake_source', () => null)])
    )

    expect(scopes.find((scope) => !scope.isOwn)?.filters).toEqual({
      sourceTypes: ['fake_source'],
      sourceFilters: { fake_source: { channelIds: ['C123'] } },
    })
  })

  it('fails closed when a source-specific grant filter is invalid or unknown', async () => {
    await db.insert(squadMemoryGrants).values({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { sourceTypes: ['fake_source'], sourceFilters: { fake_source: { channelIds: [42] } } } },
    })
    await db.insert(squadMemoryGrants).values({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { sourceFilters: { missing_source: {} } } },
    })

    const scopes = await expandReadScope(
      callerSquadId,
      {},
      adapterLookup([fakeAdapter('fake_source', () => ['channelIds must be strings'])])
    )

    expect(scopes.filter((scope) => !scope.isOwn)).toHaveLength(0)
  })
})
