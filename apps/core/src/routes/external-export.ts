import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Identity } from '../services/rbac'
import { userSessionRequired } from '../services/auth/user-session-required'
import type { ExportConsentService, EligibleExportAgent } from '../services/integrations/export/consent-service'

const enableSchema = z
  .object({
    connectionId: z.string().uuid(),
    consent: z.literal(true),
    policyVersion: z.literal(1),
    projectionVersion: z.literal(1),
  })
  .strict()
export interface ExternalExportRoutes {
  service: ExportConsentService
  findAgent(id: string): Promise<EligibleExportAgent | null>
  authorize(
    identity: Identity,
    squadId: string,
    permission: 'integrations:read' | 'integrations:export'
  ): Promise<boolean>
}
export function createExternalExportRouter(dependencies: ExternalExportRoutes): Hono {
  return new Hono()
    .get('/:id/external-export', async (c) => {
      const agent = await dependencies.findAgent(c.req.param('id'))
      const identity = c.get('identity') as Identity | undefined
      if (!agent?.squadId) return c.json({ error: 'Agent not found' }, 404)
      if (!identity) return c.json({ error: 'Unauthorized' }, 401)
      c.set('authzChecked', true)
      if (!(await dependencies.authorize(identity, agent.squadId, 'integrations:read')))
        return c.json({ error: 'Forbidden' }, 403)
      const consent = await dependencies.service.status(agent.id)
      return c.json(
        consent
          ? { state: 'enabled', connectionId: consent.connectionId, consentedAt: consent.consentedAt, revokedAt: null }
          : { state: 'disabled' }
      )
    })
    .post('/:id/external-export', zValidator('json', enableSchema), async (c) => {
      const identity = c.get('identity') as Identity | undefined
      if (identity?.type !== 'user') return userSessionRequired(c, identity, 'turn on external export')
      const agent = await dependencies.findAgent(c.req.param('id'))
      if (!agent?.squadId) return c.json({ error: 'Agent not found' }, 404)
      c.set('authzChecked', true)
      if (!(await dependencies.authorize(identity, agent.squadId, 'integrations:export')))
        return c.json({ error: 'Forbidden' }, 403)
      const body = c.req.valid('json')
      const consent = await dependencies.service.enable({
        agent,
        connectionId: body.connectionId,
        userId: identity.userId,
        policyVersion: body.policyVersion,
        projectionVersion: body.projectionVersion,
      })
      return c.json(
        { state: 'enabled', connectionId: consent.connectionId, consentedAt: consent.consentedAt, revokedAt: null },
        201
      )
    })
    .delete('/:id/external-export', async (c) => {
      const identity = c.get('identity') as Identity | undefined
      const agent = await dependencies.findAgent(c.req.param('id'))
      if (!identity) return c.json({ error: 'Unauthorized' }, 401)
      if (!agent?.squadId) return c.json({ error: 'Agent not found' }, 404)
      c.set('authzChecked', true)
      if (!(await dependencies.authorize(identity, agent.squadId, 'integrations:export')))
        return c.json({ error: 'Forbidden' }, 403)
      await dependencies.service.revoke(agent.id, agent.squadId, identity.type === 'user' ? identity.userId : undefined)
      return c.body(null, 204)
    })
}
