import { createMiddleware } from 'hono/factory'
import { amtpEngine } from '../services/amtp/engine'
import { AMTP_HEADER_INSTANCE, AMTP_HEADER_SIGNATURE, AMTP_HEADER_TIMESTAMP } from 'amtp-protocol'

/**
 * Authenticates a peer's bodyless GET (e.g. attachment pull) via its pinned Ed25519 instance key.
 *
 * Thin framing over the engine's `verifySignedGet` (spec §5.3 / §7.4 migration
 * table): this file only extracts headers + the request path from the Hono
 * context and maps the engine's uniform `{ok:false}` to a 401. All auth logic
 * (freshness check, peer lookup, signature verification over
 * `METHOD\nPATH\nTIMESTAMP_MS`) lives in `amtp-engine`. Sole auth gate for the
 * route; sets authzChecked (NOT publicRoute). Every rejection is a uniform 401
 * (no oracle).
 */
export const requirePeerSignatureGet = createMiddleware(async (c, next) => {
  const instanceHeader = c.req.header(AMTP_HEADER_INSTANCE)
  const signatureHeader = c.req.header(AMTP_HEADER_SIGNATURE)
  const timestampHeader = c.req.header(AMTP_HEADER_TIMESTAMP)
  if (!instanceHeader || !signatureHeader || !timestampHeader) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const result = await amtpEngine.verifySignedGet({
    method: 'GET',
    path: c.req.path,
    instanceHeader,
    signatureHeader,
    timestampHeader,
  })
  if (!result.ok) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  c.set('peerInstanceId', result.peerInstanceId)
  c.set('authzChecked', true)
  return next()
})
