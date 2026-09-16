import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from './index'
import { expectedCheckConstraints } from './expected-schema'

async function liveCheckConstraints(): Promise<Map<string, string>> {
  const rows = await db.execute<{ name: string; definition: string }>(sql`
    SELECT conname AS name, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE contype = 'c' AND connamespace = 'public'::regnamespace AND conrelid <> 0
  `)
  return new Map(rows.map(({ name, definition }) => [name, definition]))
}

// `drizzle-kit push` only emits CHECK constraints when it creates the table, so
// a warm test database silently kept the pre-lane-71 squad_activity_lane_check —
// every insert of a lane the current schema declares failed until someone ran
// `bun run test:db:down`. test-setup.ts now re-applies them before the push.
test('the live squad_activity lane constraint is the one schema.ts declares, not a warm database stale copy', async () => {
  const live = await liveCheckConstraints()
  expect(live.get('squad_activity_lane_check')).toContain('71')
})

test('every CHECK constraint declared in schema.ts exists in the test database', async () => {
  const live = await liveCheckConstraints()
  const expected = expectedCheckConstraints()
  expect(expected.size).toBeGreaterThan(20)
  expect([...expected.keys()].filter((name) => !live.has(name))).toEqual([])
})

// The preload drops and rebuilds CHECK constraints, so it must touch only the
// tables schema.ts declares. PostGIS ships `spatial_ref_sys` in `public` on this
// image with a CHECK of its own that nothing here could ever put back — the
// blanket drop deleted it, and the whole `public` schema is not ours to reset.
test('a CHECK on a public table schema.ts does not declare survives the preload', async () => {
  const [postgis] = await db.execute<{ present: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = 'spatial_ref_sys' AND relnamespace = 'public'::regnamespace
    ) AS present
  `)
  // Images without PostGIS have nothing to protect here.
  if (!postgis?.present) return
  const live = await liveCheckConstraints()
  expect(live.has('spatial_ref_sys_srid_check')).toBe(true)
  expect(expectedCheckConstraints().has('spatial_ref_sys_srid_check')).toBe(false)
})
