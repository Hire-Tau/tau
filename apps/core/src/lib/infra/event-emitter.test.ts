import { describe, test, expect, mock, afterAll } from 'bun:test'
import { eventEmitter } from './event-emitter'
import { LocalEventTransport, INTERNAL_EVENTS_PATH } from './local-events'

describe('eventEmitter', () => {
  test('emits and receives agent.created event', () => {
    const handler = mock(() => {})
    const unsubscribe = eventEmitter.on('agent.created', handler)

    eventEmitter.emit('agent.created', { agentId: '123', squadId: null })

    expect(handler).toHaveBeenCalledWith({ agentId: '123', squadId: null })
    unsubscribe()
  })

  test('can unsubscribe from events', () => {
    const handler = mock(() => {})
    const unsubscribe = eventEmitter.on('agent.updated', handler)

    unsubscribe()
    eventEmitter.emit('agent.updated', { agentId: '123', squadId: null })

    expect(handler).not.toHaveBeenCalled()
  })

  test('onAny receives all emitted events', () => {
    const handler = mock((..._args: any[]) => {})
    const unsubscribe = eventEmitter.onAny(handler)

    const payload = { agentId: '1', squadId: null }
    eventEmitter.emit('agent.created', payload)
    eventEmitter.emit('agent.updated', payload)

    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler.mock.calls[0]).toEqual(['agent.created', payload, { remote: false }])
    expect(handler.mock.calls[1]).toEqual(['agent.updated', payload, { remote: false }])

    unsubscribe()
  })

  test('onAny unsubscribe stops receiving events', () => {
    const handler = mock(() => {})
    const unsubscribe = eventEmitter.onAny(handler)
    unsubscribe()

    eventEmitter.emit('agent.created', { agentId: '123', squadId: null })
    expect(handler).not.toHaveBeenCalled()
  })

  test('emits message.created with minimal payload', () => {
    const handler = mock((..._args: any[]) => {})
    const unsubscribe = eventEmitter.on('message.created', handler)

    eventEmitter.emit('message.created', { messageId: 'msg-456', agentId: 'agent-456' })

    expect(handler).toHaveBeenCalledWith({ messageId: 'msg-456', agentId: 'agent-456' })
    unsubscribe()
  })
})

// The distributed emitter forwards over the loopback HTTP transport (which
// replaced pg LISTEN/NOTIFY). The `source` tag is what keeps that from turning
// into a loop: the transport echoes a notify to the SENDER's own listeners
// too (pg NOTIFY parity), so without the check an api-originated event would
// fire every api handler twice.
describe('eventEmitter over the local-events transport', () => {
  const TOKEN = 'event-emitter-test-token'

  afterAll(() => {
    // Neutralize the process-wide emitter for any test that runs after this
    // file — there is no de-initialize, so point it at a no-op forwarder.
    eventEmitter.initialize('test', async () => {})
  })

  test('forwards to the peer and does not re-fire on the sender', async () => {
    const worker = new LocalEventTransport({ token: TOKEN })
    const server = worker.serve({ port: 0 })
    const api = new LocalEventTransport({
      token: TOKEN,
      peerUrl: `http://127.0.0.1:${server.port}${INTERNAL_EVENTS_PATH}`,
    })

    const forwarded: string[] = []
    await worker.listen('app_events', (payload) => forwarded.push(payload))

    eventEmitter.initialize('api', (channel, payload) => api.notify(channel, payload))
    const stopListening = await eventEmitter.startListening((channel, cb) => api.listen(channel, cb))

    const handler = mock(() => {})
    const unsubscribe = eventEmitter.on('agent.created', handler)

    try {
      eventEmitter.emit('agent.created', { agentId: 'a1', squadId: null })
      // Let the local echo and the peer POST both settle.
      await new Promise((r) => setTimeout(r, 50))

      // The peer sees it once, tagged with the originating process.
      expect(forwarded).toHaveLength(1)
      expect(JSON.parse(forwarded[0])).toEqual({
        event: 'agent.created',
        data: { agentId: 'a1', squadId: null },
        source: 'api',
      })

      // The sender's own handler fired exactly once (the direct emit), not
      // again from the echoed app_events message.
      expect(handler).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
      await stopListening()
      await api.close()
      await worker.close()
    }
  })
})

describe('event origin meta for wildcard handlers', () => {
  test('marks locally emitted events remote:false and peer re-emits remote:true', async () => {
    const seen: Array<{ event: string; remote: boolean }> = []
    const off = eventEmitter.onAny((event, _data, meta) => {
      if (event === 'squad.updated') seen.push({ event, remote: meta.remote })
    })
    try {
      eventEmitter.emit('squad.updated', { squadId: 'local-1' })
      // Simulate the other process's forwarded copy arriving over the channel.
      let deliver: ((payload: string) => void) | null = null
      const stop = await eventEmitter.startListening(async (_channel, cb) => {
        deliver = cb
        return async () => {}
      })
      deliver!(JSON.stringify({ event: 'squad.updated', data: { squadId: 'remote-1' }, source: 'other-process' }))
      await stop()
      expect(seen).toEqual([
        { event: 'squad.updated', remote: false },
        { event: 'squad.updated', remote: true },
      ])
    } finally {
      off()
    }
  })
})
