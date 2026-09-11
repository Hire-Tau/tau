import { describe, expect, test, spyOn, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { authzSentinel } from './authz-sentinel'

describe('authzSentinel', () => {
  afterEach(() => {
    // Restore any console spies installed by tests.
    ;(console.error as any).mockRestore?.()
  })

  function appWithSentinel() {
    const app = new Hono()
    app.use('/api/*', authzSentinel)
    return app
  }

  test('allows a guarded matched api route', async () => {
    const app = appWithSentinel()
    app.get('/api/guarded', (c) => {
      c.set('authzChecked', true)
      return c.json({ ok: true })
    })

    const response = await app.request('/api/guarded')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test('allows an explicitly public matched api route', async () => {
    const app = appWithSentinel()
    app.get('/api/public', (c) => {
      c.set('publicRoute', true)
      return c.json({ ok: true })
    })

    const response = await app.request('/api/public')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test('fails closed when a matched api route runs without an authz marker', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const app = appWithSentinel()
    app.get('/api/unguarded', (c) => c.json({ leaked: true }))

    const response = await app.request('/api/unguarded')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Authorization check missing' })
    expect(errorSpy).toHaveBeenCalled()
  })

  test('preserves handler-produced 4xx responses without an authz marker', async () => {
    const app = appWithSentinel()
    app.get('/api/invalid', (c) => c.json({ error: 'Invalid input' }, 400))

    const response = await app.request('/api/invalid')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid input' })
  })

  test('does not rewrite unmatched api 404s', async () => {
    const app = appWithSentinel()

    const response = await app.request('/api/missing')

    expect(response.status).toBe(404)
  })
})
