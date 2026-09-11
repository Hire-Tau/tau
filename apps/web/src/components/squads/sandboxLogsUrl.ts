export interface SandboxLogsPathOptions {
  sandboxId: string
  tailLines?: number
  previous?: boolean
  ticket?: string
  token?: string
}

/**
 * Build the `/sandbox/<id>/logs?...` path for the logs WebSocket. The caller
 * prefixes the WS base (getWsUrl()). Auth precedence matches the backend:
 * ticket first, then token.
 */
export function buildSandboxLogsPath(opts: SandboxLogsPathOptions): string {
  const params = new URLSearchParams()
  if (opts.ticket) params.set('ticket', opts.ticket)
  else if (opts.token) params.set('token', opts.token)
  if (opts.tailLines != null) params.set('tailLines', String(opts.tailLines))
  if (opts.previous) params.set('previous', 'true')
  const qs = params.toString()
  return `/sandbox/${encodeURIComponent(opts.sandboxId)}/logs${qs ? `?${qs}` : ''}`
}
