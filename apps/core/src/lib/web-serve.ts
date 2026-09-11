import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from 'hono/bun'
import type { Hono } from 'hono'
import { resolveWebDist } from './web-dist'

type Log = { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }

function envFlag(value: string | undefined): 'on' | 'off' | 'auto' {
  if (value === undefined || value === '') return 'auto'

  const lower = value.toLowerCase()
  if (lower === '1' || lower === 'true' || lower === 'yes') return 'on'
  if (lower === '0' || lower === 'false' || lower === 'no') return 'off'

  return 'auto'
}

const HASHED_ASSET = /\/assets\/[^/]+\.[0-9a-f]{8,}\./i

/**
 * Mounts static-file serving and SPA fallback for the built web UI.
 *
 * Must be called after all `/api/*` and `/ws*` routes are registered so API and
 * WebSocket routes win before static serving is considered.
 *
 * Returns true when static handlers were mounted.
 */
export function maybeMountWebUi(app: Hono, log: Log): boolean {
  const mode = envFlag(process.env.TAU_SERVE_WEB)
  if (mode === 'off') return false

  const dist = resolveWebDist()
  const hasIndex = !!dist && existsSync(join(dist, 'index.html'))

  if (mode === 'on' && !hasIndex) {
    log.warn(
      `TAU_SERVE_WEB is enabled but no built web UI was found` +
        (dist ? ` at ${dist}` : '') +
        `. Run \`bun run build:web\` or unset TAU_SERVE_WEB.`
    )
    return false
  }
  if (mode === 'auto' && !hasIndex) return false

  const distPath = dist!

  // Never serve API or WebSocket paths from the static root. The authzSentinel
  // ignores wildcard-matched routes, so a file resolvable at `dist/api/<name>`
  // would otherwise be served unauthenticated. API/WS routes are registered
  // before this; if one reached here unmatched it should 404, not hit the disk.
  const isReservedApiPath = (p: string) => p === '/api' || p.startsWith('/api/') || p === '/ws' || p.startsWith('/ws/')

  const staticHandler = serveStatic({
    root: distPath,
    rewriteRequestPath: (path) => (path === '/' ? '/index.html' : path),
    onFound: (path, c) => {
      if (HASHED_ASSET.test(path)) {
        c.header('Cache-Control', 'public, max-age=31536000, immutable')
      } else if (path.endsWith('/index.html') || path.endsWith('/sw.js') || path.endsWith('.webmanifest')) {
        // The service worker script and manifest must revalidate on every
        // fetch, or PWA update checks can be served a heuristically-cached
        // stale copy and never see new deploys.
        c.header('Cache-Control', 'no-cache')
      }
    },
  })

  app.use('*', async (c, next) => {
    if (isReservedApiPath(c.req.path)) return next()
    return staticHandler(c, next)
  })

  app.get('*', async (c, next) => {
    if (isReservedApiPath(c.req.path)) return next()
    const accept = c.req.header('accept') ?? ''
    if (!accept.includes('text/html')) return next()

    const file = Bun.file(join(distPath, 'index.html'))
    if (!(await file.exists())) return next()

    c.header('Cache-Control', 'no-cache')
    c.header('Content-Type', 'text/html; charset=utf-8')
    return c.body(await file.bytes())
  })

  log.info(`Serving web UI from ${distPath}`)
  return true
}
