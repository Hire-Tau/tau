import { sql, type SQL } from 'drizzle-orm'

/**
 * Builds a SQL condition for UUID prefix matching.
 * Full UUIDs (36 chars) use exact match, shorter strings use LIKE prefix.
 * Use for actual UUID columns.
 */
export function uuidPrefixCondition(column: unknown, id: string): SQL {
  if (id.length >= 36) {
    return sql`${column} = ${id}::uuid`
  }
  return sql`${column}::text LIKE ${id + '%'}`
}

/**
 * Builds a SQL condition for varchar prefix matching.
 * Full UUIDs (36 chars) use exact match, shorter strings use LIKE prefix.
 * Use for varchar columns that may contain UUIDs (e.g., inbox.recipientId).
 *
 * The inbox has IDs that may be UUIDs or other strings, so we need to use a varchar prefix condition.
 */
export function varcharPrefixCondition(column: unknown, id: string): SQL {
  if (id.length >= 36) {
    return sql`${column} = ${id}`
  }
  return sql`${column} LIKE ${id + '%'}`
}

/**
 * Standard error class for ambiguous prefix matches.
 */
export class AmbiguousPrefixError extends Error {
  constructor(entityType: string, prefix: string) {
    super(`Ambiguous ${entityType} ID prefix "${prefix}" matches multiple records`)
    this.name = 'AmbiguousPrefixError'
  }
}
