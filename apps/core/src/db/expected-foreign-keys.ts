import { is } from 'drizzle-orm'
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core'
import * as schema from './schema'

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
const actions = { 'no action': 'a', restrict: 'r', cascade: 'c', 'set null': 'n', 'set default': 'd' } as const
export type ExpectedForeignKey = {
  table: string
  name: string
  definition: string
  deleteAction: string
  updateAction: string
}

/** Derive test constraints from schema.ts, including keys omitted by incremental push. */
export function expectedForeignKeys(source: Record<string, unknown> = schema): Map<string, ExpectedForeignKey> {
  const expected = new Map<string, ExpectedForeignKey>()
  for (const value of Object.values(source)) {
    if (!is(value, PgTable)) continue
    const config = getTableConfig(value)
    if (config.schema && config.schema !== 'public') continue
    for (const constraint of config.foreignKeys) {
      const reference = constraint.reference()
      const target = getTableConfig(reference.foreignTable)
      // PostgreSQL stores at most 63 bytes, without splitting a UTF-8 character.
      let name = ''
      for (const character of constraint.getName()) {
        if (Buffer.byteLength(name + character) > 63) break
        name += character
      }
      const key = `${config.name}|${name}`
      if (expected.has(key)) throw new Error(`Foreign key name collision: ${key}`)
      const onDelete = constraint.onDelete ?? 'no action'
      const onUpdate = constraint.onUpdate ?? 'no action'
      expected.set(key, {
        table: config.name,
        name,
        definition: `FOREIGN KEY (${reference.columns.map((column) => quote(column.name)).join(', ')}) REFERENCES ${quote(target.schema ?? 'public')}.${quote(target.name)} (${reference.foreignColumns.map((column) => quote(column.name)).join(', ')}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`,
        deleteAction: actions[onDelete],
        updateAction: actions[onUpdate],
      })
    }
  }
  return expected
}

/** Caller owns the test database and transaction; unrelated extension tables are untouched. */
export function foreignKeyStatements(source: Record<string, unknown> = schema): string[] {
  return [...expectedForeignKeys(source).values()].flatMap((constraint) => [
    `ALTER TABLE "public".${quote(constraint.table)} DROP CONSTRAINT IF EXISTS ${quote(constraint.name)}`,
    `ALTER TABLE "public".${quote(constraint.table)} ADD CONSTRAINT ${quote(constraint.name)} ${constraint.definition}`,
  ])
}
