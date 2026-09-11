import { createMiddleware } from 'hono/factory'
import { getSessionCookie } from '../services/auth/session-cookie'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
export const CSRF_HEADER = 'x-tau-csrf'

/**
 * CSRF defense for cookie-authenticated browser requests. The session cookie is
 * sent automatically, so a state-changing request authenticated *by cookie* must
 * also carry a custom header that only first-party JS can attach — a cross-site
 * caller can't set a custom header without a CORS preflight, which the origin
 * allowlist gates. Bearer/header-authenticated requests (CLI, agents) are exempt:
 * they aren't driven by an ambient cookie, so they aren't CSRF-able.
 */
export const csrfProtection = createMiddleware(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next()
  const hasBearer = !!c.req.header('Authorization') || !!c.req.header('X-Auth-Token')
  if (hasBearer || !getSessionCookie(c)) return next()
  if (!c.req.header(CSRF_HEADER)) {
    return c.json({ error: 'Missing CSRF token' }, 403)
  }
  return next()
})
