import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { like } from 'drizzle-orm'
import { db, squads, squadMemoryGrants } from '../../../db'
import { SquadMemoryGrant } from '../../../entities/SquadMemoryGrant'
import { canWriteToSquad } from './write-scope'

describe('canWriteToSquad', () => {
  let prefix: string
  let callerSquadId: string
  let targetSquadId: string

  beforeEach(async () => {
    prefix = `wscope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const rows = await db
      .insert(squads)
      .values([
        { name: `${prefix} Caller`, purpose: 'caller', status: 'active' },
        { name: `${prefix} Target`, purpose: 'target', status: 'active' },
      ])
      .returning()
    callerSquadId = rows[0].id
    targetSquadId = rows[1].id
  })

  afterEach(async () => {
    await db.delete(squadMemoryGrants)
    await db.delete(squads).where(like(squads.name, `${prefix}%`))
  })

  it('allows writes when caller equals target (own squad)', async () => {
    const result = await canWriteToSquad(callerSquadId, callerSquadId, {
      path: '/memory/notes/foo.md',
      sourceType: 'memory_file',
    })
    expect(result.allowed).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('denies cross-squad write with no grant', async () => {
    const result = await canWriteToSquad(callerSquadId, targetSquadId, {
      path: '/memory/notes/foo.md',
      sourceType: 'memory_file',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('no_grant')
  })

  it('denies cross-squad write when grant has only read policy', async () => {
    await SquadMemoryGrant.create({
      sourceSquadId: targetSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { sourceTypes: ['memory_file'], paths: ['/memory/**'] } },
    })
    const result = await canWriteToSquad(callerSquadId, targetSquadId, {
      path: '/memory/notes/foo.md',
      sourceType: 'memory_file',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('no_write_policy')
  })

  it('allows cross-squad write inside granted path glob', async () => {
    await SquadMemoryGrant.create({
      sourceSquadId: targetSquadId,
      granteeSquadId: callerSquadId,
      policy: { write: { sourceTypes: ['memory_file'], paths: ['/memory/contributions/**'] } },
    })
    const result = await canWriteToSquad(callerSquadId, targetSquadId, {
      path: '/memory/contributions/engineering/notes.md',
      sourceType: 'memory_file',
    })
    expect(result.allowed).toBe(true)
  })

  it('denies cross-squad write outside granted path glob', async () => {
    await SquadMemoryGrant.create({
      sourceSquadId: targetSquadId,
      granteeSquadId: callerSquadId,
      policy: { write: { sourceTypes: ['memory_file'], paths: ['/memory/contributions/**'] } },
    })
    const result = await canWriteToSquad(callerSquadId, targetSquadId, {
      path: '/memory/secrets/api-keys.md',
      sourceType: 'memory_file',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('path_not_covered')
  })

  it('denies cross-squad write to disallowed source type', async () => {
    await SquadMemoryGrant.create({
      sourceSquadId: targetSquadId,
      granteeSquadId: callerSquadId,
      policy: { write: { sourceTypes: ['memory_file'], paths: ['/memory/**'] } },
    })
    const result = await canWriteToSquad(callerSquadId, targetSquadId, {
      path: '/memory/notes/foo.md',
      sourceType: 'agent_thread',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('source_type_not_covered')
  })

  it('ignores expired grants', async () => {
    const past = new Date(Date.now() - 60_000)
    await SquadMemoryGrant.create({
      sourceSquadId: targetSquadId,
      granteeSquadId: callerSquadId,
      policy: { write: { sourceTypes: ['memory_file'], paths: ['/memory/**'] } },
      expiresAt: past,
    })
    const result = await canWriteToSquad(callerSquadId, targetSquadId, {
      path: '/memory/notes/foo.md',
      sourceType: 'memory_file',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('no_grant')
  })
})
