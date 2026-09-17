import type { db } from '../../db'
import { hasPermission, hasUserPermissionWithExecutor } from './permissions'

/**
 * The subset of `candidateIds` that holds `permission` (optionally on one squad), resolved with
 * per-candidate failure isolation.
 *
 * `Promise.allSettled`, not `Promise.all`: these fan-outs decide who gets told about something, and
 * one unresolvable subject — a corrupt role chain, a lost connection — must cost that one
 * candidate its notice rather than discarding every candidate that resolved fine. A rejection is
 * treated as NOT permitted (fail closed) and reported through `onUnresolved` ONCE for the batch,
 * not once per candidate, so a database blip cannot write a log line per recipient.
 *
 * Candidate lists here are bounded by subscription or recipient rows, so this is a small fan of
 * mostly-cached checks; use {@link getUserIdsWithPermission} when the question is "everyone who
 * holds this", which is one query instead.
 *
 * `executor` routes the checks through a caller's transaction, so a fan-out that gates writes sees
 * the same snapshot (and takes the same locks) as those writes. It bypasses the permission cache,
 * which is correct inside a transaction that may have just changed a role.
 */
export async function filterUserIdsWithPermission(
  candidateIds: readonly string[],
  permission: string,
  squadId: string | undefined,
  onUnresolved?: (summary: { failed: number; total: number; reason: unknown }) => void,
  executor?: Pick<typeof db, 'select'>
): Promise<string[]> {
  if (candidateIds.length === 0) return []
  const holds = (userId: string) =>
    executor
      ? hasUserPermissionWithExecutor(executor, userId, permission, squadId)
      : hasPermission({ type: 'user', userId }, permission, squadId)
  const settled = await Promise.allSettled(candidateIds.map(async (userId) => ((await holds(userId)) ? userId : null)))
  const failed = settled.filter((result) => result.status === 'rejected')
  if (failed.length > 0) {
    onUnresolved?.({ failed: failed.length, total: candidateIds.length, reason: failed[0].reason })
  }
  return settled
    .map((result) => (result.status === 'fulfilled' ? result.value : null))
    .filter((userId): userId is string => userId !== null)
}
