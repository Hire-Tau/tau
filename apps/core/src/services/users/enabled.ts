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
 */
export async function listEnabledUserIds(candidateIds: string[]): Promise<string[]> {
  if (candidateIds.length === 0) return []
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, candidateIds), isNull(users.disabledAt)))
  const enabled = new Set(rows.map(({ id }) => id))
  return candidateIds.filter((userId) => enabled.has(userId))
}
