import { Hono } from 'hono'
import * as actionsService from '../services/agents/actions'
import type { Identity } from '../services/rbac'

export const actionsRouter = new Hono().get('/pending', async (c) => {
  const identity: Identity | undefined = c.get('identity')
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)

  const actions = await actionsService.listPendingActionsForIdentity(identity)
  c.set('authzChecked', true)
  return c.json(actions)
})
