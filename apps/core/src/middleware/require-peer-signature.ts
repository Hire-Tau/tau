import { createMiddleware } from 'hono/factory'
import { amtpEngine } from '../services/amtp/engine'
import { AMTP_HEADER_INSTANCE, AMTP_HEADER_SIGNATURE } from 'amtp-protocol'

declare module 'hono' {
  interface ContextVariableMap {
    peerInstanceId?: string
    amtpRawBody?: string
  }
}

/**
 * Authenticates a federation peer's machine-route request via its pinned Ed25519
 * instance key. Peer requests are cookieless + token-less; the receiver route adds
 * an explicit exact-path bypass in identityMiddleware so they reach this middleware
 * with no Identity. This middleware is the SOLE auth gate for the receiver route
 * (no user RBAC).
 *
 * Thin framing over the engine's `verifyInboxPost` (spec §5.2 / §7.4 migration
 * table): this file only extracts headers + the raw body from the Hono context
 * and maps the engine's uniform `{ok:false}` to a 401. All auth logic (peer
 * lookup, signature verification) lives in `amtp-engine`.
 *
 * The signature is verified over the EXACT raw request-body bytes, read once here
 * via `c.req.text()` and re-exposed as `amtpRawBody`. The handler MUST read
 * `amtpRawBody` rather than call `c.req.json()`: the latter returns a parsed
 * object, not the signed raw string, so it would not match the verified bytes. On
 * success it sets `authzChecked` (NOT `publicRoute`) so authzSentinel passes; every
 * rejection returns 401, which the sentinel preserves (it only rewrites non-4xx
 * responses).
 */
export const requirePeerSignature = createMiddleware(async (c, next) => {
  // Validate headers before buffering the body, so unauthenticated probes do not
  // force a full body read.
  const instanceHeader = c.req.header(AMTP_HEADER_INSTANCE)
  const signatureHeader = c.req.header(AMTP_HEADER_SIGNATURE)
  if (!instanceHeader || !signatureHeader) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const rawBody = await c.req.text()

  const result = await amtpEngine.verifyInboxPost({ instanceHeader, signatureHeader, rawBody })
  if (!result.ok) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  c.set('peerInstanceId', result.peerInstanceId)
  c.set('amtpRawBody', rawBody)
  c.set('authzChecked', true)
  return next()
})
