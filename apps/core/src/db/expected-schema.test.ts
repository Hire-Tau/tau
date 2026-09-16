import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { check, integer, pgSchema, pgTable, text } from 'drizzle-orm/pg-core'
import { expectedCheckConstraints, expectedTableColumns, findSchemaDrift, parseColumnRows } from './expected-schema'

describe('expectedTableColumns', () => {
  test('derives tables and their snake_case column names from schema.ts', () => {
    const expected = expectedTableColumns()

    const agents = expected.get('agents')
    expect(agents).toBeDefined()
    // Spot-check both a trivially-present column and one that only exists if
    // the real drizzle column metadata (not the TS property name) was read.
    expect(agents!.has('id')).toBe(true)
    expect(agents!.has('squad_id')).toBe(true)
    expect(agents!.has('created_at')).toBe(true)
    // The TS property is `squadId`; reading property names instead of db names
    // would put that here instead.
    expect(agents!.has('squadId')).toBe(false)

    expect(expected.get('messages')?.has('metadata')).toBe(true)
    expect(expected.get('squads')?.has('id')).toBe(true)
  })

  test('covers the whole schema, not a sample of it', () => {
    // Guards against a regression where the enumeration silently matches only
    // a handful of exports — the check is worthless if it only knows 3 tables.
    expect(expectedTableColumns().size).toBeGreaterThan(50)
  })

  test('ignores exports that are not tables', () => {
    const expected = expectedTableColumns({
      messageRoleEnum: { some: 'pgEnum-like object' },
      notATable: 'string',
      alsoNot: null,
    })
    expect(expected.size).toBe(0)
  })
})

describe('expectedCheckConstraints', () => {
  test('derives declared constraints, their table, and recreatable SQL from schema.ts', () => {
    const expected = expectedCheckConstraints()
    const lane = expected.get('squad_activity_lane_check')
    expect(lane?.table).toBe('squad_activity')
    // The lane list itself, not just the name — this is what gets re-applied.
    expect(lane?.expression).toContain('71')
    expect(lane?.expression).toContain('"squad_activity"."lane"')
    expect(expected.size).toBeGreaterThan(20)
  })

  test('ignores exports that are not tables, and tables outside the public schema', () => {
    const other = pgSchema('other')
    expect(
      expectedCheckConstraints({
        notATable: 'string',
        alsoNot: null,
        elsewhere: other.table('elsewhere', { n: integer('n') }, (t) => [check('elsewhere_n', sql`${t.n} > 0`)]),
      }).size
    ).toBe(0)
  })

  test('refuses a constraint whose SQL would need a bound parameter', () => {
    const table = pgTable('bound', { name: text('name') }, (t) => [
      // A JS value in the template becomes $1, which is not legal in DDL.
      check('bound_name', sql`${t.name} = ${'literal-by-accident'}`),
    ])
    expect(() => expectedCheckConstraints({ table })).toThrow(/bound parameters/)
  })

  test('refuses two constraints that collide once Postgres truncates the name', () => {
    // Postgres stores 63 bytes; silently keeping the last one would re-apply a
    // definition under a name the other constraint also claims.
    const base = 'a'.repeat(63)
    const table = pgTable('collide', { n: integer('n') }, (t) => [
      check(`${base}_first`, sql`${t.n} > 0`),
      check(`${base}_second`, sql`${t.n} < 100`),
    ])
    expect(() => expectedCheckConstraints({ table })).toThrow(/truncat/i)
  })
})

describe('findSchemaDrift', () => {
  const expected = new Map([
    ['agents', new Set(['id', 'squad_id'])],
    ['messages', new Set(['id', 'metadata'])],
  ])

  test('reports nothing when the database has everything', () => {
    const actual = new Map([
      ['agents', new Set(['id', 'squad_id'])],
      ['messages', new Set(['id', 'metadata'])],
    ])
    expect(findSchemaDrift(expected, actual)).toEqual({ missingTables: [], missingColumns: [] })
  })

  test('reports an entirely missing table', () => {
    const actual = new Map([['messages', new Set(['id', 'metadata'])]])
    expect(findSchemaDrift(expected, actual)).toEqual({ missingTables: ['agents'], missingColumns: [] })
  })

  test('reports a missing column on a table that does exist', () => {
    const actual = new Map([
      ['agents', new Set(['id'])],
      ['messages', new Set(['id', 'metadata'])],
    ])
    expect(findSchemaDrift(expected, actual)).toEqual({ missingTables: [], missingColumns: ['agents.squad_id'] })
  })

  test('does not report a missing table twice as missing columns', () => {
    const actual = new Map<string, Set<string>>()
    const drift = findSchemaDrift(expected, actual)
    expect(drift.missingTables).toEqual(['agents', 'messages'])
    expect(drift.missingColumns).toEqual([])
  })

  test('ignores tables and columns the database has but schema.ts does not', () => {
    // PostGIS's spatial_ref_sys lives in public on the test image, and push
    // leaves older columns behind — neither means the push failed.
    const actual = new Map([
      ['agents', new Set(['id', 'squad_id', 'legacy_column'])],
      ['messages', new Set(['id', 'metadata'])],
      ['spatial_ref_sys', new Set(['srid'])],
    ])
    expect(findSchemaDrift(expected, actual)).toEqual({ missingTables: [], missingColumns: [] })
  })
})

describe('parseColumnRows', () => {
  test('groups psql -tA rows by table', () => {
    const parsed = parseColumnRows('agents|id\nagents|squad_id\nmessages|metadata\n')
    expect(parsed.get('agents')).toEqual(new Set(['id', 'squad_id']))
    expect(parsed.get('messages')).toEqual(new Set(['metadata']))
  })

  test('skips blank lines and rows without a separator', () => {
    const parsed = parseColumnRows('\n  \nagents|id\ngarbage\n')
    expect(parsed.size).toBe(1)
    expect(parsed.get('agents')).toEqual(new Set(['id']))
  })

  test('an empty result set yields no tables, so every table reads as missing', () => {
    // This is the exact shape of the bug: push applied nothing, so the drift
    // report must name every table rather than quietly finding no drift.
    expect(parseColumnRows('').size).toBe(0)
  })
})
