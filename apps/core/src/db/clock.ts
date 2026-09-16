import { sql, type SQL } from 'drizzle-orm'

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
 */
export function databaseClockNow(): SQL {
  return sql`(clock_timestamp() at time zone 'utc')`
}
