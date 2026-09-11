export interface SystemLogsPathOptions {
  component?: 'api' | 'worker' | 'all'
  tailLines?: number
  follow?: boolean
  ticket?: string
}

/**
 * Build the `/system/logs?...` path for the system logs WebSocket. The caller
 * prefixes the WS base (getWsUrl()). Auth precedence matches the backend:
 * ticket, when available; otherwise the browser's HttpOnly session cookie authenticates.
 */
export function buildSystemLogsPath(opts: SystemLogsPathOptions): string {
  const params = new URLSearchParams()
  if (opts.ticket) params.set('ticket', opts.ticket)
  if (opts.component && opts.component !== 'all') params.set('component', opts.component)
  if (opts.tailLines != null) params.set('tailLines', String(opts.tailLines))
  if (opts.follow === false) params.set('follow', 'false')
  const qs = params.toString()
  return `/system/logs${qs ? `?${qs}` : ''}`
}
