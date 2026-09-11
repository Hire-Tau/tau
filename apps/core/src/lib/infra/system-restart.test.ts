import { afterEach, describe, expect, it } from 'bun:test'
import { INTERNAL_EVENTS_PATH, LocalEventTransport } from './local-events'
import { createWorkerRestartHandler, RESTART_EXIT_CODE, SYSTEM_RESTART_CHANNEL } from './system-restart'

const silentLog = { info: () => {}, warn: () => {}, error: () => {} }

/** A shutdown whose completion the test controls, so re-entry can be exercised mid-flight. */
function controlledShutdown() {
  let calls = 0
  let release!: () => void
  let fail!: (error: Error) => void
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  const shutdown = async () => {
    calls++
    await gate
  }
  return { shutdown, release, fail, calls: () => calls }
}

/** Resolve after `n` microtask turns without touching timers. */
async function settle(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('createWorkerRestartHandler', () => {
  it('names a channel the api and worker agree on', () => {
    expect(SYSTEM_RESTART_CHANNEL).toBe('system_restart')
  })

  it('runs the graceful shutdown, then exits NON-ZERO so Restart=on-failure brings the worker back', async () => {
    const shutdown = controlledShutdown()
    const exits: number[] = []
    const handler = createWorkerRestartHandler({
      shutdown: shutdown.shutdown,
      exit: (code) => void exits.push(code),
      log: silentLog,
    })

    handler('{"requestedAt":"now"}')
    await settle()
    expect(shutdown.calls()).toBe(1)
    // Exit must WAIT for shutdown (owned executions are requeued in there).
    expect(exits).toEqual([])

    shutdown.release()
    await settle()
    expect(exits).toHaveLength(1)
    expect(exits[0]).not.toBe(0)
    expect(exits[0]).toBe(RESTART_EXIT_CODE)
    expect(RESTART_EXIT_CODE).not.toBe(0)
  })

  it('ignores a second restart message while shutdown is already in flight', async () => {
    const shutdown = controlledShutdown()
    const exits: number[] = []
    const handler = createWorkerRestartHandler({
      shutdown: shutdown.shutdown,
      exit: (code) => void exits.push(code),
      log: silentLog,
    })

    handler('first')
    handler('second')
    await settle()
    expect(shutdown.calls()).toBe(1)

    shutdown.release()
    await settle()
    handler('third — after shutdown finished, still must not re-run')
    await settle()
    expect(shutdown.calls()).toBe(1)
    expect(exits).toEqual([RESTART_EXIT_CODE])
  })

  it('still exits non-zero when the graceful shutdown itself fails', async () => {
    const shutdown = controlledShutdown()
    const exits: number[] = []
    const errors: unknown[] = []
    const handler = createWorkerRestartHandler({
      shutdown: shutdown.shutdown,
      exit: (code) => void exits.push(code),
      log: { ...silentLog, error: (...args: unknown[]) => void errors.push(args) },
    })

    handler('payload')
    shutdown.fail(new Error('requeue exploded'))
    await settle()
    expect(exits).toEqual([RESTART_EXIT_CODE])
    expect(errors).toHaveLength(1)
  })
})

describe('api → worker restart over the real loopback transport', () => {
  const open: LocalEventTransport[] = []
  afterEach(async () => {
    for (const t of open) await t.close()
    open.length = 0
  })

  it('a notify on SYSTEM_RESTART_CHANNEL from the api side runs the worker shutdown and exits non-zero', async () => {
    const token = 'restart-test-token'
    const worker = new LocalEventTransport({ token })
    open.push(worker)
    const server = worker.serve({ port: 0 })
    const api = new LocalEventTransport({ token, peerUrl: `http://127.0.0.1:${server.port}${INTERNAL_EVENTS_PATH}` })
    open.push(api)

    const shutdown = controlledShutdown()
    const exits: number[] = []
    await worker.listen(
      SYSTEM_RESTART_CHANNEL,
      createWorkerRestartHandler({ shutdown: shutdown.shutdown, exit: (code) => void exits.push(code), log: silentLog })
    )

    await api.notify(SYSTEM_RESTART_CHANNEL, '{"source":"api"}')
    await settle()
    expect(shutdown.calls()).toBe(1)
    expect(exits).toEqual([])
    shutdown.release()
    await settle()
    expect(exits).toEqual([RESTART_EXIT_CODE])
  })
})
