import { is } from 'drizzle-orm'
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core'
import * as schema from './schema'

/**
 * Table name -> set of column names, as declared in `schema.ts`.
 *
 * This is the source of truth the test database is checked against once
 * `drizzle-kit push` claims success (see test-setup.ts). Deriving it from the
 * schema module rather than a hand-maintained list is what makes the check
 * self-updating: a table or column added to `schema.ts` is automatically part
 * of what the test DB must contain, with nothing to remember to update here.
 *
 * COLUMNS, deliberately — not indexes or constraints. Columns are what the
 * tests depend on, they are what a silently-skipped push leaves missing, and
 * they are the one thing push applies faithfully: a push-built and a
 * migration-built database have zero column differences. Their INDEXES differ
 * by 51, because push silently skips most partial and expression indexes, so
 * checking those here would fail on a perfectly healthy push-built database.
 */
export function expectedTableColumns(source: Record<string, unknown> = schema): Map<string, Set<string>> {
  const expected = new Map<string, Set<string>>()
  for (const value of Object.values(source)) {
    if (!is(value, PgTable)) continue
    const config = getTableConfig(value)
    // Only the default schema — the test DB check queries `public`.
    if (config.schema && config.schema !== 'public') continue
    expected.set(config.name, new Set(config.columns.map((column) => column.name)))
  }
  return expected
}

export type SchemaDrift = {
  missingTables: string[]
  missingColumns: string[]
}

/**
 * What `expected` has that `actual` does not. One-directional on purpose:
 * extra tables/columns in the database are not drift we care about here
 * (PostGIS's `spatial_ref_sys`, a column left over from a branch switch, an
 * older migration's table) — the question this answers is strictly "did
 * everything the tests need actually get created?".
 */
export function findSchemaDrift(expected: Map<string, Set<string>>, actual: Map<string, Set<string>>): SchemaDrift {
  const missingTables: string[] = []
  const missingColumns: string[] = []

  for (const [table, columns] of expected) {
    const actualColumns = actual.get(table)
    if (!actualColumns) {
      missingTables.push(table)
      continue
    }
    for (const column of columns) {
      if (!actualColumns.has(column)) missingColumns.push(`${table}.${column}`)
    }
  }

  return { missingTables: missingTables.sort(), missingColumns: missingColumns.sort() }
}

/**
 * Parse `psql -tA` output of `SELECT table_name || '|' || column_name ...`
 * into the shape findSchemaDrift wants.
 */
export function parseColumnRows(stdout: string): Map<string, Set<string>> {
  const actual = new Map<string, Set<string>>()
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf('|')
    if (separator === -1) continue
    const table = trimmed.slice(0, separator)
    const column = trimmed.slice(separator + 1)
    let columns = actual.get(table)
    if (!columns) {
      columns = new Set()
      actual.set(table, columns)
    }
    columns.add(column)
  }
  return actual
}
