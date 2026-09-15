import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { maybeMountWebUi } from './web-serve'

function fakeLog() {
  const calls: { level: string; args: unknown[] }[] = []
  return {
    calls,
    info: (...args: unknown[]) => calls.push({ level: 'info', args }),
    warn: (...args: unknown[]) => calls.push({ level: 'warn', args }),
  }
}

function buildFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tau-web-fixture-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>')
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {})')
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Tau"}')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'app.abc12345.js'), 'console.log("ok")')
  return dir
}

describe('maybeMountWebUi', () => {
  const origEnv = process.env.TAU_SERVE_WEB
  const origDist = process.env.TAU_WEB_DIST
  let dist: string

  beforeEach(() => {
    dist = buildFixture()
    process.env.TAU_WEB_DIST = dist
  })

  afterEach(() => {
    if (origEnv === undefined) delete process.env.TAU_SERVE_WEB
    else process.env.TAU_SERVE_WEB = origEnv
    if (origDist === undefined) delete process.env.TAU_WEB_DIST
    else process.env.TAU_WEB_DIST = origDist
    rmSync(dist, { recursive: true, force: true })
  })

  function setupApp() {
    const app = new Hono()
    // Pre-registered API route mirrors apps/core/src/index.ts ordering.
    app.get('/api/health', (c) => c.json({ status: 'ok' }))
    const log = fakeLog()
    const mounted = maybeMountWebUi(app, log)
    // Sentinel: anything past static + SPA fallback is a hard 404.
    app.all('*', (c) => c.json({ error: 'not-found' }, 404))
    return { app, log, mounted }
  }

  it('serves index.html at /', async () => {
    process.env.TAU_SERVE_WEB = '1'
    const { app, mounted } = setupApp()
    expect(mounted).toBe(true)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(res.headers.get('Cache-Control')).toContain('no-cache')
    expect(await res.text()).toContain('app')
  })

  it('serves hashed assets with immutable cache header', async () => {
    process.env.TAU_SERVE_WEB = '1'
    const { app } = setupApp()
    const res = await app.request('/assets/app.abc12345.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('immutable')
  })

  it('serves sw.js with no-cache so update checks always revalidate', async () => {
    process.env.TAU_SERVE_WEB = '1'
    const { app } = setupApp()
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('no-cache')
  })

  it('serves the web manifest with no-cache', async () => {
    process.env.TAU_SERVE_WEB = '1'
    const { app } = setupApp()
    const res = await app.request('/manifest.webmanifest')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('no-cache')
  })

  it('falls back to index.html for client routes when Accept includes text/html', async () => {
    process.env.TAU_SERVE_WEB = '1'
    const { app } = setupApp()
    const res = await app.request('/squads/123', {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
  })

  it('does not fall back for JSON clients', async () => {
    process.env.TAU_SERVE_WEB = '1'
    const { app } = setupApp()
    const res = await app.request('/agents/123', {
      headers: { Accept: 'application/json' },
    })
    expect(res.status).toBe(404)
  })

  it('does not shadow /api/* routes', async () => {
    process.env.TAU_SERVE_WEB = '1'
    const { app } = setupApp()
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('TAU_SERVE_WEB=0 disables even when dist exists', () => {
    process.env.TAU_SERVE_WEB = '0'
    const { mounted } = setupApp()
    expect(mounted).toBe(false)
  })

  it('auto-enables when dist exists and env is unset', async () => {
    delete process.env.TAU_SERVE_WEB
    const { app, mounted } = setupApp()
    expect(mounted).toBe(true)
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })

  it('warns and stays disabled when TAU_SERVE_WEB=1 but no dist exists', () => {
    process.env.TAU_SERVE_WEB = '1'
    process.env.TAU_WEB_DIST = join(dist, '__missing__')
    const { mounted, log } = setupApp()
    expect(mounted).toBe(false)
    expect(log.calls.some((c) => c.level === 'warn')).toBe(true)
  })
})
