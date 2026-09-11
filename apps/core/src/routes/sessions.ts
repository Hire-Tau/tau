import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { db } from '../db'
import { sessions } from '../db/schema'

export const sessionsRouter = new Hono()

sessionsRouter.get('/', async (c) => {
  c.set('authzChecked', true)
  const identity = c.get('identity')
  if (identity.type !== 'user') return c.json({ error: 'Only users can manage sessions' }, 403)
  const userSessions = await db
    .select({
      id: sessions.id,
      userAgent: sessions.userAgent,
      ipAddress: sessions.ipAddress,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, identity.userId))
  return c.json(userSessions)
})

sessionsRouter.delete('/:id', async (c) => {
  c.set('authzChecked', true)
  const identity = c.get('identity')
  if (identity.type !== 'user') return c.json({ error: 'Only users can manage sessions' }, 403)
  await db.delete(sessions).where(and(eq(sessions.id, c.req.param('id')), eq(sessions.userId, identity.userId)))
  return c.body(null, 204)
})

sessionsRouter.delete('/', async (c) => {
  c.set('authzChecked', true)
  const identity = c.get('identity')
  if (identity.type !== 'user') return c.json({ error: 'Only users can manage sessions' }, 403)
  await db.delete(sessions).where(eq(sessions.userId, identity.userId))
  return c.body(null, 204)
})
