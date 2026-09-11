import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { db } from '../../../db'
import { memoryAccessAudit, squads } from '../../../db/schema'
import { recordMemoryAccess } from './audit'

describe('recordMemoryAccess', () => {
  const callerSquadId = crypto.randomUUID()
  const sourceSquadId = crypto.randomUUID()

  beforeAll(async () => {
    await db.insert(squads).values([
      { id: callerSquadId, name: 'Caller', purpose: 'Test', status: 'active' },
      { id: sourceSquadId, name: 'Source', purpose: 'Test', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.delete(memoryAccessAudit).where(eq(memoryAccessAudit.callerSquadId, callerSquadId))
    await db.delete(squads).where(eq(squads.id, sourceSquadId))
    await db.delete(squads).where(eq(squads.id, callerSquadId))
  })

  it('writes one row per cross-squad source touched and skips own squad', async () => {
    await recordMemoryAccess({
      callerSquadId,
      action: 'search',
      sourceSquadIds: [callerSquadId, sourceSquadId],
      resultCount: 3,
    })

    const rows = await db
      .select()
      .from(memoryAccessAudit)
      .where(and(eq(memoryAccessAudit.callerSquadId, callerSquadId), eq(memoryAccessAudit.action, 'search')))
    expect(rows).toHaveLength(1)
    expect(rows[0].sourceSquadId).toBe(sourceSquadId)
    expect(rows[0].resultCount).toBe(3)
  })
})
