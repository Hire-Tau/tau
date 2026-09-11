import { describe, expect, test } from 'bun:test'
import { expectedTableColumns, findSchemaDrift, parseColumnRows } from './expected-schema'

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
