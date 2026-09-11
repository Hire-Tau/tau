import type { Context } from 'hono'
import { MalformedJsonBodyError } from '../middleware/json-body-errors'

/** Parse a request JSON body without exposing runtime-specific parser errors. */
export async function parseJsonBody(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() }
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof MalformedJsonBodyError) return { ok: false }
    throw error
  }
}
