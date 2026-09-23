import { Hono } from 'hono'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { db, users, channelIdentityLinks, channelLinkChallenges, channelInstances } from '../db'
import type { Identity } from '../services/rbac'
import { startChannelLink, confirmChannelLink } from '../services/channel-access'
import { userSessionRequired } from '../services/auth/user-session-required'

export const channelLinksRouter = new Hono<{
  Variables: { userId: string; identity: Identity; authzChecked: boolean }
}>()
  .use('*', async (c, next) => {
    const identity = c.get('identity')
    c.set('authzChecked', true)
    if (identity?.type !== 'user') return userSessionRequired(c, identity, 'manage linked accounts')
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, identity.userId), isNull(users.disabledAt)))
    if (!user) return c.json({ error: 'Account is unavailable.' }, 403)
    c.set('userId', user.id)
    await next()
  })
  .get('/', async (c) => {
    const links = await db
      .select({
        id: channelIdentityLinks.id,
        provider: channelInstances.provider,
        instanceName: channelInstances.name,
        externalUserId: channelIdentityLinks.externalUserId,
        externalUserName: channelIdentityLinks.externalUserName,
      })
      .from(channelIdentityLinks)
      .innerJoin(channelInstances, eq(channelInstances.id, channelIdentityLinks.instanceId))
      .where(eq(channelIdentityLinks.userId, c.get('userId')))
    const pending = await db
      .select({
        id: channelLinkChallenges.id,
        expiresAt: channelLinkChallenges.expiresAt,
        provider: channelInstances.provider,
        instanceName: channelInstances.name,
        externalUserId: channelLinkChallenges.externalUserId,
        externalUserName: channelLinkChallenges.externalUserName,
      })
      .from(channelLinkChallenges)
      .leftJoin(channelInstances, eq(channelInstances.id, channelLinkChallenges.instanceId))
      .where(and(eq(channelLinkChallenges.userId, c.get('userId')), gt(channelLinkChallenges.expiresAt, new Date())))
    return c.json({ links, pending })
  })
  .post('/', async (c) => c.json(await startChannelLink(c.get('userId')), 201))
  .post('/:id/confirm', async (c) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.req.param('id')))
      return c.json({ error: 'Invalid link request ID' }, 400)
    return c.json(await confirmChannelLink(c.get('userId'), c.req.param('id')))
  })
  .delete('/:id', async (c) => {
    const id = c.req.param('id')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      return c.json({ error: 'Invalid link ID' }, 400)
    await db
      .delete(channelIdentityLinks)
      .where(and(eq(channelIdentityLinks.id, id), eq(channelIdentityLinks.userId, c.get('userId'))))
    await db
      .delete(channelLinkChallenges)
      .where(and(eq(channelLinkChallenges.id, id), eq(channelLinkChallenges.userId, c.get('userId'))))
    return c.json({ ok: true })
  })
