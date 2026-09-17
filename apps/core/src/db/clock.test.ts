import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from './index'
import { databaseClockNow, readDatabaseClock } from './clock'

/** Read a `timestamp`-shaped value back the way drizzle reads one: as UTC wall time. */
function asStoredInstant(written: string): Date {
  return new Date(`${String(written).replace(' ', 'T')}Z`)
}

describe('databaseClockNow', () => {
  /**
   * `ended_at` and `cycle_started_at` are `timestamp` WITHOUT time zone, and drizzle's contract for
   * those columns is UTC wall time (it writes `toISOString()` and reads back `value + '+0000'`). A
   * bare `clock_timestamp()` cast into such a column would instead be converted using the SESSION's
   * TimeZone — UTC on our containers, but that is server configuration, not a guarantee. On a
   * non-UTC session that would store an instant hours off, silently and consistently.
   */
  test('round-trips to the correct UTC instant under a non-UTC session TimeZone', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL TimeZone='America/New_York'`)
      const [{ zone }] = await tx.execute<{ zone: string }>(sql`select current_setting('TimeZone') as zone`)
      expect(zone).toBe('America/New_York')

      const [{ written, reference }] = await tx.execute<{ written: string; reference: Date | string }>(
        sql`select ${databaseClockNow()} as written, clock_timestamp() as reference`
      )
      // `reference` is a timestamptz, so its absolute instant is unambiguous. Had the helper used
      // the session zone, these would differ by the UTC offset (4-5 hours), not milliseconds.
      expect(Math.abs(asStoredInstant(written).getTime() - new Date(reference).getTime())).toBeLessThan(2_500)
    })
  })

  test('reads the same instant as the database under the default session TimeZone', async () => {
    const [{ written, reference }] = await db.execute<{ written: string; reference: Date | string }>(
      sql`select ${databaseClockNow()} as written, clock_timestamp() as reference`
    )
    expect(Math.abs(asStoredInstant(written).getTime() - new Date(reference).getTime())).toBeLessThan(2_500)
  })

  /**
   * Sub-millisecond precision does not survive a JS Date, and these columns are read back and then
   * compared for equality — the continuation cycle's compare-and-swap does exactly that, and every
   * one of those swaps silently became a no-op while the stamp carried microseconds.
   */
  test('truncates to milliseconds so a JS Date round-trips exactly', async () => {
    const [{ written }] = await db.execute<{ written: string }>(sql`select ${databaseClockNow()} as written`)
    expect(String(written)).not.toMatch(/\.\d{4,}/)
    const roundTripped = asStoredInstant(written)
    expect(roundTripped.toISOString().replace('T', ' ').replace('Z', '')).toContain(
      String(written).replace(' ', ' ').split('.')[0]
    )
  })

  test('readDatabaseClock agrees with the database, not the host', async () => {
    const [{ reference }] = await db.execute<{ reference: Date | string }>(sql`select clock_timestamp() as reference`)
    const read = await readDatabaseClock()
    expect(Math.abs(read.getTime() - new Date(reference).getTime())).toBeLessThan(2_500)
  })
})
