import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { csrfProtection } from './csrf'

function app() {
  const a = new Hono()
  a.use('/api/*', csrfProtection)
  a.get('/api/thing', (c) => c.json({ ok: true }))
  a.post('/api/thing', (c) => c.json({ ok: true }))
  return a
}

describe('csrfProtection', () => {
  test('safe method (GET) is always allowed, even cookie-authed', async () => {
    const res = await app().request('/api/thing', { headers: { Cookie: 'tau_session=t' } })
    expect(res.status).toBe(200)
  })

  test('cookie-authed mutation WITHOUT the CSRF header → 403', async () => {
    const res = await app().request('/api/thing', { method: 'POST', headers: { Cookie: 'tau_session=t' } })
    expect(res.status).toBe(403)
  })

  test('cookie-authed mutation WITH the CSRF header → allowed', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { Cookie: 'tau_session=t', 'X-Tau-Csrf': '1' },
    })
    expect(res.status).toBe(200)
  })

  test('bearer-authed mutation is exempt (CLI/agents not cookie-driven)', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { Authorization: 'Bearer tau_agent_x' },
    })
    expect(res.status).toBe(200)
  })

  test('X-Auth-Token mutation is exempt', async () => {
    const res = await app().request('/api/thing', { method: 'POST', headers: { 'X-Auth-Token': 'tok' } })
    expect(res.status).toBe(200)
  })

  test('no cookie and no bearer → exempt (CSRF only guards ambient-cookie auth)', async () => {
    const res = await app().request('/api/thing', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('a bearer header bypasses the cookie path (no CSRF header needed)', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { Cookie: 'tau_session=t', Authorization: 'Bearer tau_agent_x' },
    })
    expect(res.status).toBe(200)
  })
})
