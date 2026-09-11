import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'

/**
 * Guards the wiring between `Bun.serve`'s fetch handler and Hono's bun adapter.
 *
 * Hono resolves the Bun server out of `c.env` to perform an upgrade
 * (`getBunServer`: `"server" in c.env ? c.env.server : c.env`). `Bun.serve`
 * invokes `fetch(request, server)`, so a handler forwarding only `request`
 * leaves env undefined and every upgrade throws `c.env is not an Object`.
 *
 * Not hypothetical: #870 replaced the bare `fetch: app.fetch` — which Bun called
 * with both arguments — with a wrapper that captures the peer address and passed
 * only `request`. It produced 1,319 logged failures over ~14 hours and silently
 * disabled every live update in the product, while HTTP kept working so nothing
 * else looked broken.
 *
 * A real server and a real WebSocket are used deliberately: the defect lives in
 * the argument handoff, which a mocked `app.fetch` cannot observe.
 */
function makeApp() {
  const app = new Hono()
  app.get(
    '/ws',
    upgradeWebSocket(() => ({
      onOpen: (_event, ws) => ws.send('open'),
    }))
  )
  return app
}

/** Resolves 'open' only if the upgrade succeeded and the socket delivered a message. */
function tryUpgrade(port: number | undefined): Promise<'open' | 'failed'> {
  return new Promise((resolve) => {
    if (port === undefined) throw new Error('server did not report a port')
    const socket = new WebSocket(`ws://localhost:${port}/ws`)
    let settled = false
    const settle = (outcome: 'open' | 'failed') => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        // socket may already be closed; the outcome is what matters
      }
      resolve(outcome)
    }
    socket.addEventListener('message', (event) => settle(event.data === 'open' ? 'open' : 'failed'))
    socket.addEventListener('error', () => settle('failed'))
    socket.addEventListener('close', () => settle('failed'))
    setTimeout(() => settle('failed'), 2_000)
  })
}

describe('Bun.serve → Hono websocket upgrade', () => {
  test('forwarding the server as env upgrades the connection', async () => {
    const app = makeApp()
    const server = Bun.serve({ port: 0, fetch: (request, bunServer) => app.fetch(request, bunServer), websocket })
    try {
      expect(await tryUpgrade(server.port)).toBe('open')
    } finally {
      server.stop(true)
    }
  })

  test('forwarding only the request breaks the upgrade — the #870 regression', async () => {
    const app = makeApp()
    const server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request), websocket })
    try {
      expect(await tryUpgrade(server.port)).toBe('failed')
    } finally {
      server.stop(true)
    }
  })
})
