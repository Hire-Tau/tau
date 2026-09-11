import { describe, expect, it } from 'bun:test'
import { subsystem, startSubsystems, stopSubsystems, type Subsystem } from './subsystem'

/** Minimal logger fake capturing every call for assertions. */
function fakeLogger() {
  const calls: { level: 'info' | 'warn' | 'error'; args: unknown[] }[] = []
  return {
    calls,
    log: {
      info: (...args: unknown[]) => calls.push({ level: 'info', args }),
      warn: (...args: unknown[]) => calls.push({ level: 'warn', args }),
      error: (...args: unknown[]) => calls.push({ level: 'error', args }),
    },
  }
}

describe('subsystem', () => {
  it('constructs a Subsystem from name/start/stop', () => {
    const start = () => {}
    const stop = () => {}
    const s = subsystem('foo', start, stop)
    expect(s.name).toBe('foo')
    expect(s.start).toBe(start)
    expect(s.stop).toBe(stop)
  })
})

describe('startSubsystems', () => {
  it('starts subsystems in forward (list) order', async () => {
    const order: string[] = []
    const list: Subsystem[] = [
      subsystem(
        'a',
        () => {
          order.push('a')
        },
        () => {}
      ),
      subsystem(
        'b',
        () => {
          order.push('b')
        },
        () => {}
      ),
      subsystem(
        'c',
        () => {
          order.push('c')
        },
        () => {}
      ),
    ]

    const { log } = fakeLogger()
    await startSubsystems(list, log)

    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('awaits async start() calls before moving to the next subsystem', async () => {
    const order: string[] = []
    const list: Subsystem[] = [
      subsystem(
        'a',
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          order.push('a')
        },
        () => {}
      ),
      subsystem(
        'b',
        () => {
          order.push('b')
        },
        () => {}
      ),
    ]

    const { log } = fakeLogger()
    await startSubsystems(list, log)

    expect(order).toEqual(['a', 'b'])
  })

  it('on a start error, logs, stops the already-started prefix in reverse, and rethrows', async () => {
    const events: string[] = []
    const list: Subsystem[] = [
      subsystem(
        'a',
        () => {
          events.push('start:a')
        },
        () => {
          events.push('stop:a')
        }
      ),
      subsystem(
        'b',
        () => {
          events.push('start:b')
        },
        () => {
          events.push('stop:b')
        }
      ),
      subsystem(
        'c',
        () => {
          events.push('start:c')
          throw new Error('boom')
        },
        () => {
          events.push('stop:c')
        }
      ),
      subsystem(
        'd',
        () => {
          events.push('start:d')
        },
        () => {
          events.push('stop:d')
        }
      ),
    ]

    const { log, calls } = fakeLogger()

    await expect(startSubsystems(list, log)).rejects.toThrow('boom')

    // c failed to start (its start() threw), so only a and b — the already
    // started prefix — get stopped, in reverse order. c and d are never
    // stopped: c never finished starting, d never started at all.
    expect(events).toEqual(['start:a', 'start:b', 'start:c', 'stop:b', 'stop:a'])

    const errorLogs = calls.filter((c) => c.level === 'error')
    expect(errorLogs.length).toBeGreaterThan(0)
  })

  it('rethrows the start error (not a stop error) when a stop() throws during start-failure unwind', async () => {
    const events: string[] = []
    const list: Subsystem[] = [
      subsystem(
        'a',
        () => {
          events.push('start:a')
        },
        () => {
          events.push('stop:a')
        }
      ),
      subsystem(
        'b',
        () => {
          events.push('start:b')
        },
        () => {
          events.push('stop:b')
          throw new Error('stop-b-failed')
        }
      ),
      subsystem(
        'c',
        () => {
          events.push('start:c')
          throw new Error('start-c-failed')
        },
        () => {
          events.push('stop:c')
        }
      ),
    ]

    const { log, calls } = fakeLogger()

    // c's start error is the one rethrown, not b's stop error.
    await expect(startSubsystems(list, log)).rejects.toThrow('start-c-failed')

    // a and b (the already-started prefix) are both attempted in reverse
    // order despite b's stop() throwing; a still gets stopped after b fails.
    expect(events).toEqual(['start:a', 'start:b', 'start:c', 'stop:b', 'stop:a'])

    const errorLogs = calls.filter((c) => c.level === 'error')
    // One error log for c's start failure, one for b's stop failure.
    expect(errorLogs.length).toBe(2)
  })
})

describe('stopSubsystems', () => {
  it('stops subsystems in reverse order', async () => {
    const order: string[] = []
    const list: Subsystem[] = [
      subsystem(
        'a',
        () => {},
        () => {
          order.push('a')
        }
      ),
      subsystem(
        'b',
        () => {},
        () => {
          order.push('b')
        }
      ),
      subsystem(
        'c',
        () => {},
        () => {
          order.push('c')
        }
      ),
    ]

    const { log } = fakeLogger()
    await stopSubsystems(list, log)

    expect(order).toEqual(['c', 'b', 'a'])
  })

  it('isolates a throwing stop: logs it and continues stopping the rest', async () => {
    const order: string[] = []
    const list: Subsystem[] = [
      subsystem(
        'a',
        () => {},
        () => {
          order.push('a')
        }
      ),
      subsystem(
        'b',
        () => {},
        () => {
          throw new Error('stop-b-failed')
        }
      ),
      subsystem(
        'c',
        () => {},
        () => {
          order.push('c')
        }
      ),
    ]

    const { log, calls } = fakeLogger()

    // Never throws, even though b's stop() threw.
    await expect(stopSubsystems(list, log)).resolves.toBeUndefined()

    // c and a still get stopped despite b failing in between.
    expect(order).toEqual(['c', 'a'])

    const errorLogs = calls.filter((c) => c.level === 'error')
    expect(errorLogs.length).toBe(1)
  })

  it('never throws even if every stop() fails', async () => {
    const list: Subsystem[] = [
      subsystem(
        'a',
        () => {},
        () => {
          throw new Error('a-failed')
        }
      ),
      subsystem(
        'b',
        () => {},
        () => {
          throw new Error('b-failed')
        }
      ),
    ]

    const { log, calls } = fakeLogger()

    await expect(stopSubsystems(list, log)).resolves.toBeUndefined()
    expect(calls.filter((c) => c.level === 'error').length).toBe(2)
  })
})
