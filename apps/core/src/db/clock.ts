import { sql, type SQL } from 'drizzle-orm'
import { db } from './index'

/**
 * The DATABASE's current instant, for writing a `timestamp` (no time zone) column.
 *
 * Two clocks exist in a deployment: the Postgres server's and each Core host's. A column written
 * from `new Date()` carries the host's clock; one written from `clock_timestamp()` carries the
 * database's. Comparing two such columns compares two clocks, and the difference between them is
 * NTP drift — invisible in development, and unbounded after a host sleeps or a VM resyncs.
 * `executions.started_at` (`defaultNow()`) and `executions.run_started_at` already come from the
 * database; use this so anything compared against them does too.
 *
 * The explicit `at time zone 'utc'` matters. A `timestamp` column has no offset, and drizzle
 * writes a JS Date to one as `toISOString()` and reads it back as `value + '+0000'` — so the
 * column's contract is UTC wall time. A bare `clock_timestamp()` (a `timestamptz`) cast into that
 * column would instead use the SESSION's TimeZone, which is UTC on our containers but is server
 * configuration, not a guarantee. Writing UTC explicitly keeps the column's meaning independent of
 * how any given deployment configures Postgres.
 *
 * For a `timestamptz` column pass `clock_timestamp()` directly; the conversion is unnecessary
 * there because the offset is stored.
 *
 * The truncation to milliseconds is NOT cosmetic. `clock_timestamp()` has microsecond resolution,
 * a JS Date has millisecond resolution, and drizzle reads these columns into Dates — so a value
 * with microseconds does not survive a round trip. Anything that reads such a column and then
 * compares it back for equality silently stops matching: `work_stream_continuations.cycle_started_at`
 * is exactly that, the optimistic-concurrency check in `continuation.ts` compares the Date it read
 * against the stored column, and every one of those compare-and-swaps became a no-op until this
 * truncation was added. Storing only what a Date can represent removes the whole class. Sub-
 * millisecond ordering is not lost in practice: the comparisons that care break ties on id.
 */
export function databaseClockNow(): SQL {
  return sql`date_trunc('milliseconds', clock_timestamp() at time zone 'utc')`
}

/**
 * The database's current instant, as a JS Date, for code that must compare in memory against
 * columns the database stamped (`executions.ended_at`, `run_started_at`, …).
 *
 * A sweep that takes its `now` from the app host compares two clocks just as surely as a column
 * written from one does; reading the instant from the same clock that wrote the rows removes the
 * skew from the comparison rather than bounding it. One round trip per sweep, not per row.
 */
export async function readDatabaseClock(executor: Pick<typeof db, 'execute'> = db): Promise<Date> {
  const rows = await executor.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`)
  return new Date(rows[0].now)
}
