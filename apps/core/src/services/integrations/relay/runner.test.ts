import { describe, expect, test } from 'bun:test'
import { HostedIntegrationRelayRunner } from './runner'
import { PlatformRequestError, type platformRequest } from '../../platform/instance-client'
import type { RelayDelivery } from '@tau/shared/integration-relay'

function fixture() {
  const id = crypto.randomUUID(),
    revision = crypto.randomUUID()
  const state = {
    now: 0,
    managed: true,
    enabled: true,
    available: true,
    revision,
    token: 'current-token',
    interests: [{ connectionId: id, squadId: 's1', repository: 'org/repo' }],
    remote: [] as { connectionId: string; connectionRevision: string }[],
    deliveries: [] as RelayDelivery[],
    calls: [] as { path: string; body: any }[],
    dispatched: [] as string[],
    errors: [] as string[],
    failAck: false,
    failDispatch: false,
    duringPull: () => {},
  }
  const delivery: RelayDelivery = {
    id: crypto.randomUUID(),
    leaseToken: crypto.randomUUID(),
    connectionId: id,
    connectionRevision: revision,
    deliveryId: crypto.randomUUID(),
    resourceId: '12',
    resourceKey: 'org/repo',
    eventType: 'issues',
    payload: {},
  }
  const request: typeof platformRequest = async (input) => {
    state.calls.push({ path: input.path.split('/').at(-1)!, body: input.body })
    const path = state.calls.at(-1)!.path
    if (path === 'status') return input.schema.parse({ enabled: state.enabled, connections: state.remote })
    if (path === 'pull') {
      state.duringPull()
      return input.schema.parse({ deliveries: state.deliveries })
    }
    if (path === 'ack' && state.failAck) throw new PlatformRequestError('broker_unavailable', true)
    return input.schema.parse({ ok: true })
  }
  const runner = new HostedIntegrationRelayRunner({
    managed: () => state.managed,
    interests: async () => state.interests,
    resolve: async (connectionId) =>
      state.available ? { id: connectionId, revision: state.revision, accessToken: state.token } : undefined,
    request,
    dispatch: async (event, interests) => {
      if (state.failDispatch) throw new Error('relay_authorization_unavailable')
      state.dispatched.push(...interests.map((interest) => `${event.id}:${interest.squadId}`))
    },
    now: () => state.now,
    onError: (code) => state.errors.push(code),
  })
  return { state, runner, delivery, id }
}
describe('managed relay consumer', () => {
  test('self-hosted and an unconfigured Platform do no subscription or delivery work', async () => {
    const { state, runner } = fixture()
    state.managed = false
    runner.start()
    await runner.tick()
    expect(state.calls).toEqual([])
    state.managed = true
    state.enabled = false
    await runner.tick()
    expect(state.calls.map((call) => call.path)).toEqual(['status'])
    await runner.stop()
  })
  test('subscribes automatically, renews on metadata/revision change, and sends refreshed tokens', async () => {
    const { state, runner } = fixture()
    await runner.tick()
    expect(state.calls.map((call) => call.path)).toEqual(['status', 'subscribe', 'pull'])
    state.calls = []
    state.now += 5_000
    state.token = 'rotated'
    await runner.tick()
    expect(state.calls.map((call) => call.path)).toEqual(['pull'])
    expect(state.calls[0]!.body.accessToken).toBe('rotated')
    state.interests[0]!.repository = 'org/other'
    await runner.tick()
    expect(state.calls.at(-2)!.body.repositories).toEqual(['org/other'])
    state.revision = crypto.randomUUID()
    await runner.tick()
    expect(state.calls.at(-2)!.body.connectionRevision).toBe(state.revision)
    state.calls = []
    state.now += 300_000
    await runner.tick()
    expect(state.calls.map((call) => call.path)).toContain('subscribe')
  })
  test('only current connection/squad/repository interests receive a delivery', async () => {
    const { state, runner, delivery } = fixture()
    state.deliveries = [delivery]
    state.interests.push({ ...state.interests[0]!, squadId: 's2' })
    await runner.tick()
    expect(state.dispatched).toEqual([`${delivery.id}:s1`, `${delivery.id}:s2`])
    expect(state.calls.at(-1)!.path).toBe('ack')
  })
  test('detach or reconnect during the HTTP request cannot dispatch old content', async () => {
    for (const mode of ['detach', 'revision', 'interest']) {
      const { state, runner, delivery } = fixture()
      state.deliveries = [delivery]
      state.duringPull = () => {
        if (mode === 'detach') state.available = false
        else if (mode === 'revision') state.revision = crypto.randomUUID()
        else state.interests = []
      }
      await runner.tick()
      expect(state.dispatched).toEqual([])
    }
  })
  test('lost acknowledgments remain retryable and stale response authority is rejected', async () => {
    const { state, runner, delivery } = fixture()
    state.deliveries = [delivery]
    state.failAck = true
    await runner.tick()
    expect(state.errors).toEqual(['broker_unavailable'])
    state.calls = []
    state.now += 5_000
    await runner.tick()
    expect(state.calls).toEqual([])
    state.now += 120_000
    state.failAck = false
    await runner.tick()
    expect(state.calls.at(-1)!.path).toBe('ack')
    state.deliveries = [{ ...delivery, connectionRevision: crypto.randomUUID() }]
    await runner.tick()
    expect(state.errors.at(-1)).toBe('invalid_response')
  })
  test('failed dispatch leaves a pulled event unacknowledged until authorization recovers', async () => {
    const { state, runner, delivery } = fixture()
    state.deliveries = [delivery]
    state.failDispatch = true
    await runner.tick()
    expect(state.calls.map((call) => call.path)).toEqual(['status', 'subscribe', 'pull'])
    expect(state.dispatched).toEqual([])
    expect(state.errors).toEqual(['relay_unavailable'])
    state.failDispatch = false
    state.now += 120_000
    await runner.tick()
    expect(state.dispatched).toEqual([`${delivery.id}:s1`])
    expect(state.calls.at(-1)!.path).toBe('ack')
  })
  test('restart discovers orphan subscriptions, and bounded round-robin does not starve connections', async () => {
    const { state, runner } = fixture()
    state.remote = [{ connectionId: crypto.randomUUID(), connectionRevision: crypto.randomUUID() }]
    state.interests = Array.from({ length: 6 }, () => ({
      connectionId: crypto.randomUUID(),
      squadId: 's1',
      repository: 'org/repo',
    }))
    await runner.tick()
    expect(state.calls.some((call) => call.path === 'unsubscribe')).toBe(true)
    expect(state.calls.filter((call) => call.path === 'pull')).toHaveLength(4)
    await runner.tick()
    expect(new Set(state.calls.filter((call) => call.path === 'pull').map((call) => call.body.connectionId)).size).toBe(
      6
    )
  })
  test('stop aborts in-flight transport and waits for the owned scan', async () => {
    let ready!: () => void
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    let aborted = false
    const runner = new HostedIntegrationRelayRunner({
      managed: () => true,
      interests: async () => [],
      resolve: async () => undefined,
      request: async (input) => {
        ready()
        await new Promise<void>((resolve) =>
          input.signal!.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve()
            },
            { once: true }
          )
        )
        throw new Error('aborted')
      },
      dispatch: async () => {},
      onError: () => {
        throw new Error('shutdown must not report error')
      },
    })
    runner.start()
    await started
    await runner.stop()
    expect(aborted).toBe(true)
  })
})
