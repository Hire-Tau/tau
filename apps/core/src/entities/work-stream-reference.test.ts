import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { inArray, eq } from 'drizzle-orm'
import { db, squads, workStreams } from '../db'
import { WorkStream } from './WorkStream'
import { AmbiguousPrefixError } from '../db/prefix-match'

const squadIds = [crypto.randomUUID(), crypto.randomUUID()]
describe('public work references', () => {
  beforeAll(async () => {
    await db.insert(squads).values(squadIds.map((id) => ({ id, name: 'Reference fixture', purpose: 'test' })))
  })
  afterAll(async () => {
    await db.delete(squads).where(inArray(squads.id, squadIds))
  })
  test('numbers are unique across squads and concurrent creators; all lookup forms resolve the same UUID', async () => {
    const rows = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const [row] = await db
          .insert(workStreams)
          .values({ squadId: squadIds[i % 2]!, title: 'Test' })
          .returning()
        return row!
      })
    )
    expect(new Set(rows.map((row) => row.number)).size).toBe(rows.length)
    for (const row of rows) {
      for (const reference of [String(row.number), `#${row.number}`, row.id, row.id.slice(0, 8)]) {
        expect((await WorkStream.mustFind(reference)).id).toBe(row.id)
      }
      expect((await WorkStream.mustFind(row.id)).toJson().number).toBe(row.number)
    }
    const removed = rows[0]!
    await db.delete(workStreams).where(eq(workStreams.id, removed.id))
    const [next] = await db.insert(workStreams).values({ squadId: squadIds[0]!, title: 'New work' }).returning()
    expect(next!.number).toBeGreaterThan(Math.max(...rows.map((row) => row.number)))
    expect(await WorkStream.find(`#${removed.number}`)).toBeNull()
  })
  test('rejects malformed and ambiguous prefixes rather than wildcard matching', async () => {
    const prefix = crypto.randomUUID().slice(0, 8)
    await db.insert(workStreams).values(
      [0, 1].map((i) => ({
        id: `${prefix}-1234-4000-8000-${String(i).padStart(12, '0')}`,
        squadId: squadIds[0]!,
        title: 'Ambiguous',
      }))
    )
    await expect(WorkStream.find(`${prefix}-`)).rejects.toBeInstanceOf(AmbiguousPrefixError)
    for (const invalid of ['%', '_', 'not-a-uuid', '#0', '#-1', '#2147483648', ''])
      expect(await WorkStream.find(invalid)).toBeNull()
  })
})
