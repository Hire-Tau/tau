import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { pushRelayConfig, sendRelayAlert } from './relay'
const token = `tau_pri_${randomUUID()}_${'a'.repeat(43)}`
const config = pushRelayConfig({ TAU_PUSH_RELAY_TOKEN: token })!

test('relay uses only a push credential and strips content and arbitrary URLs', async () => {
  let captured: RequestInit | undefined
  const fetcher = (async (_url, init) => {
    captured = init
    return Response.json({ accepted: true })
  }) as (url: string, init: RequestInit) => Promise<Response>
  const result = await sendRelayAlert(
    `tau_prd_${'b'.repeat(43)}`,
    {
      title: 'private chat',
      body: 'private body',
      url: 'https://evil.example',
      origin: 'https://wrong.example',
      squadId: randomUUID(),
    },
    { config, fetch: fetcher }
  )
  expect(result.accepted).toBe(true)
  const payload = JSON.parse(String(captured!.body))
  expect(Object.keys(payload.routing)).toEqual(['squadId'])
  expect(JSON.stringify(payload)).not.toContain('private')
  expect(captured!.redirect).toBe('error')
  expect(captured!.headers).toEqual({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })
})
test('denial and network errors are redacted and never retry', async () => {
  let calls = 0
  const fetcher = (async () => {
    calls++
    throw new Error(`secret ${token}`)
  }) as (url: string, init: RequestInit) => Promise<Response>
  expect(await sendRelayAlert(`tau_prd_${'b'.repeat(43)}`, {}, { config, fetch: fetcher })).toEqual({
    accepted: false,
    reason: 'relay_unavailable',
  })
  expect(calls).toBe(1)
  expect(
    await sendRelayAlert(
      `tau_prd_${'b'.repeat(43)}`,
      {},
      {
        config,
        fetch: (async () => new Response('', { status: 403 })) as (url: string, init: RequestInit) => Promise<Response>,
      }
    )
  ).toEqual({ accepted: false, reason: 'pro_required' })
})
test('account tokens and malformed credentials cannot configure the relay', () => {
  expect(() => pushRelayConfig({ TAU_PUSH_RELAY_TOKEN: 'tau_pat_account-token' })).toThrow('push-only')
  expect(pushRelayConfig({})).toBeNull()
  expect(config.instanceId).toHaveLength(36)
})
