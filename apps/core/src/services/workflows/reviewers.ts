import { eq, isNull, inArray } from 'drizzle-orm'
import { db, users } from '../../db'
import { hasPermission } from '../rbac'

export async function listWorkflowReviewers(squadId: string) {
  const people = await db
    .select({ id: users.id, name: users.displayName, email: users.email })
    .from(users)
    .where(isNull(users.disabledAt))
  const eligible = []
  for (const person of people) {
    if (await hasPermission({ type: 'user', userId: person.id }, 'workstreams:review', squadId))
      eligible.push({
        id: person.id,
        name: person.name?.trim() ? `${person.name.trim()} (${person.email})` : person.email,
      })
  }
  return eligible
}

export async function validateAssignedReviewers(ids: string[], squadId: string) {
  if (new Set(ids).size !== ids.length || ids.length > 64) throw new Error('Choose up to 64 distinct reviewers')
  if (!ids.length) return
  const people = await db.select().from(users).where(inArray(users.id, ids))
  for (const id of ids) {
    const person = people.find((user) => user.id === id)
    if (
      !person ||
      person.disabledAt ||
      !(await hasPermission({ type: 'user', userId: id }, 'workstreams:review', squadId))
    )
      throw new Error('Assigned reviewers must be active users with work-stream review permission in this squad')
  }
}

export async function isWorkflowReviewer(userId: string, squadId: string) {
  const [person] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId))
  return (
    !!person && !person.disabledAt && (await hasPermission({ type: 'user', userId }, 'workstreams:review', squadId))
  )
}
