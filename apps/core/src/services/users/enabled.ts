import { and, inArray, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { users } from '../../db/schema'

/**
 * The enabled subset of `candidateIds`, in the order given.
 *
 * A disabled account cannot open the Action Center and must never receive retained-device push
 * or stream content, but the rows that nominate recipients — question recipients, attention
 * subscriptions, permission grants — outlive the account being disabled. Every human fan-out
 * therefore passes its candidates through here rather than trusting the nominating row.
 *
 * Pass `executor` to read inside a caller's transaction, so the enabled check sees the same
 * snapshot as the writes it gates (and takes the same locks).
 */
export async function listEnabledUserIds(
  candidateIds: string[],
  executor: Pick<typeof db, 'select'> = db
): Promise<string[]> {
  if (candidateIds.length === 0) return []
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, candidateIds), isNull(users.disabledAt)))
  const enabled = new Set(rows.map(({ id }) => id))
  return candidateIds.filter((userId) => enabled.has(userId))
}
