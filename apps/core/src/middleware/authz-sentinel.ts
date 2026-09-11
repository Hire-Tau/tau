import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { createLogger } from '../lib/infra/logger'

const log = createLogger('authz-sentinel')

function matchedApplicationRoute(c: Context): boolean {
  if (c.res.status === 404) return false

  return c.req.matchedRoutes.some((route) => {
    // Middleware-only matches include wildcard paths such as `/api/*` or `*`.
    // A concrete route match has its registered route path here.
    if (route.path === '*' || route.path.endsWith('/*')) return false
    return route.path.startsWith('/api/')
  })
}

/**
 * Runtime RBAC backstop for protected API routes.
 *
 * Mount this after identityMiddleware and before protected `/api/*` routers. If a
 * matched API route completes without either an RBAC guard (`authzChecked`) or an
 * explicit public-route marker (`publicRoute`), replace the response with a 500.
 * This fails closed for accidentally unguarded routes in production.
 */
export const authzSentinel = createMiddleware(async (c, next) => {
  await next()

  if (!matchedApplicationRoute(c)) return
  if (c.get('authzChecked') || c.get('publicRoute')) return

  // Preserve handler-produced client errors (validation, denial, not-found). The
  // sentinel remains a fail-closed backstop for unguarded successful routes.
  if (c.res.status >= 400 && c.res.status < 500) return

  log.error('API route completed without RBAC guard or public-route marker', {
    method: c.req.method,
    path: c.req.path,
    routePath: c.req.routePath,
    status: c.res.status,
  })

  c.res = c.json({ error: 'Authorization check missing' }, 500)
})
