import { describe, expect, test } from 'bun:test'
import {
  pollTestNodeOutboxDelivery,
  pollTestNodeOutboxFailure,
  type TestNodeOutboxRow,
} from './node-conformance-outbox-poller'

const row = (
  status: TestNodeOutboxRow['status'],
  attempts = 1,
  lastError: string | null = null
): TestNodeOutboxRow => ({
  id: 'target',
  status,
  attempts,
  lastError,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function fakeTime() {
  let current = 0
  const sleeps: number[] = []
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      current += ms
    },
    sleeps,
  }
}

describe('pollTestNodeOutboxFailure', () => {
  test('cancels a genuinely pending nested query at the remaining deadline', async () => {
    let now = 0
    let nestedAborted = false
    const poll = pollTestNodeOutboxFailure('target', 'wrong-pin-terminal', 500, {
      queryRows: async (_remainingMs, signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              nestedAborted = true
              now = 500
              reject(new Error('amtp-cli:outbox list:terminal-output; stdout tail=; stderr tail='))
            },
            { once: true }
          )
        }),
      sleep: async (ms) => {
        now += ms
      },
      now: () => now,
      intervalMs: 50,
      diagnostics: () => 'serve exitCode=null signalCode=null',
    }).then(
      () => undefined,
      (error: unknown) => error
    )
    const didNotSettle = Symbol('query-cancellation-did-not-settle')
    let watchdog: Timer | undefined
    const outcome = await Promise.race([
      poll,
      new Promise<typeof didNotSettle>((resolve) => {
        watchdog = setTimeout(() => resolve(didNotSettle), 750)
      }),
    ])
    if (watchdog) clearTimeout(watchdog)

    expect(outcome).not.toBe(didNotSettle)
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain('last outbox query failure=amtp-cli:outbox list:terminal-output')
    expect(nestedAborted).toBe(true)
  })

  test('bounds a hung empty-output nested query within the remaining outer budget', async () => {
    let now = 0
    let observedBudget = 0

    await expect(
      pollTestNodeOutboxFailure('target', 'wrong-pin-terminal', 500, {
        queryRows: async (remainingMs) => {
          observedBudget = remainingMs
          now += remainingMs
          throw new Error('amtp-cli:outbox list:terminal-output; stdout tail=; stderr tail=')
        },
        sleep: async (ms) => {
          now += ms
        },
        now: () => now,
        intervalMs: 50,
        diagnostics: () => 'serve exitCode=null signalCode=null',
      })
    ).rejects.toThrow('last outbox query failure=amtp-cli:outbox list:terminal-output; stdout tail=; stderr tail=')
    expect(observedBudget).toBe(500)
  })

  test('rejects an exact failed row returned after the overall deadline', async () => {
    let current = 0
    const query = deferred<TestNodeOutboxRow[]>()
    const result = pollTestNodeOutboxFailure('target', 'unknown recipient terminal failure', 1_000, {
      queryRows: () => query.promise,
      now: () => current,
      sleep: async () => {},
      intervalMs: 750,
      diagnostics: () => 'serve diagnostics',
    })

    current = 1_001
    query.resolve([row('failed', 1, 'HTTP 404')])

    await expect(result).rejects.toThrow('unknown recipient terminal failure timed out after 1000ms')
  })

  test('fails immediately when the exact row is unexpectedly delivered', async () => {
    const time = fakeTime()
    let queries = 0

    await expect(
      pollTestNodeOutboxFailure('target', 'unknown recipient terminal failure', 20_000, {
        queryRows: async () => {
          queries++
          return [{ ...row('failed'), id: 'different-row' }, row('delivered', 2)]
        },
        ...time,
        intervalMs: 750,
        diagnostics: () => 'serve diagnostics',
      })
    ).rejects.toThrow(
      'unknown recipient terminal failure unexpectedly delivered; last outbox row={"id":"target","status":"delivered","attempts":2,"lastError":null}; serve diagnostics'
    )
    expect(queries).toBe(1)
    expect(time.sleeps).toEqual([])
  })

  test('waits through an initial delivering state for the exact row to fail', async () => {
    const time = fakeTime()
    const states = [row('delivering'), row('failed', 1, 'HTTP 404: unknown recipient')]

    const failed = await pollTestNodeOutboxFailure('target', 'unknown recipient terminal failure', 20_000, {
      queryRows: async () => [states.shift()!],
      ...time,
      intervalMs: 750,
      diagnostics: () => 'serve diagnostics',
    })

    expect(failed).toMatchObject({ id: 'target', status: 'failed', lastError: 'HTTP 404: unknown recipient' })
    expect(time.sleeps).toEqual([750])
  })
})

describe('pollTestNodeOutboxDelivery', () => {
  test('retries a transient query failure and then succeeds', async () => {
    const time = fakeTime()
    let queries = 0

    await pollTestNodeOutboxDelivery('target', 'attachment delivery', 2_000, {
      queryRows: async () => {
        queries++
        if (queries === 1) throw new Error('temporary sqlite contention')
        return [row('delivered')]
      },
      ...time,
      intervalMs: 750,
      diagnostics: () => 'serve diagnostics',
    })

    expect(queries).toBe(2)
    expect(time.sleeps).toEqual([750])
  })

  test('waits the full attachment deadline for a broken CLI and reports its latest bounded failure', async () => {
    const time = fakeTime()
    let queries = 0

    const result = pollTestNodeOutboxDelivery('target', 'attachment delivery', 70_000, {
      queryRows: async () => {
        queries++
        throw new Error(`query failure ${queries}`)
      },
      ...time,
      intervalMs: 35_000,
      diagnostics: () => 'bounded serve stderr',
    })

    await expect(result).rejects.toThrow(
      'attachment delivery timed out after 70000ms; last outbox query failure=query failure 2; last outbox row=null; bounded serve stderr'
    )
    expect(queries).toBe(2)
  })

  test('uses the configured interval without starting another query after the deadline', async () => {
    const time = fakeTime()
    let queries = 0

    await expect(
      pollTestNodeOutboxDelivery('target', 'attachment delivery', 2_250, {
        queryRows: async () => {
          queries++
          return [row('pending')]
        },
        ...time,
        intervalMs: 750,
        diagnostics: () => 'diagnostics',
      })
    ).rejects.toThrow('timed out after 2250ms')

    expect(time.sleeps).toEqual([750, 750, 750])
    expect(queries).toBe(3)
  })

  test('does not spawn a query when the remaining budget is too small to be useful', async () => {
    let current = 0
    let queries = 0

    await expect(
      pollTestNodeOutboxDelivery('target', 'attachment delivery', 1_000, {
        queryRows: async () => {
          queries++
          return [row('pending')]
        },
        now: () => current,
        sleep: async (ms) => {
          current += ms
        },
        intervalMs: 950,
        minQueryBudgetMs: 100,
        diagnostics: () => 'diagnostics',
      })
    ).rejects.toThrow('timed out after 1000ms')

    expect(queries).toBe(1)
  })

  test('does not accept a query result returned after the overall deadline', async () => {
    let current = 0
    const requestedTimeouts: number[] = []

    await expect(
      pollTestNodeOutboxDelivery('target', 'attachment delivery', 1_000, {
        queryRows: async (remainingMs) => {
          requestedTimeouts.push(remainingMs)
          current = 1_001
          return [row('delivered')]
        },
        now: () => current,
        sleep: async () => {},
        intervalMs: 750,
        diagnostics: () => 'diagnostics',
      })
    ).rejects.toThrow('timed out after 1000ms')

    expect(requestedTimeouts).toEqual([1_000])
  })

  test('bounds oversized query and row errors in terminal diagnostics', async () => {
    const time = fakeTime()
    const oversizedQueryError = `query-tail-${'q'.repeat(20_000)}`
    const oversizedRowError = `row-tail-${'r'.repeat(20_000)}`
    let queries = 0

    const result = pollTestNodeOutboxDelivery('target', 'attachment delivery', 1_500, {
      queryRows: async () => {
        queries++
        if (queries === 1) return [row('pending', 1, oversizedRowError)]
        throw new Error(oversizedQueryError)
      },
      ...time,
      intervalMs: 750,
      diagnostics: () => 'bounded server diagnostics',
    })

    try {
      await result
      throw new Error('expected polling to time out')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('last outbox query failure=…qqq')
      expect(message).toContain('last outbox row={"id":"target"')
      expect(message).toContain('"lastError":"…rrr')
      expect(message.length).toBeLessThan(35_000)
    }
  })

  test('stops polling immediately for permanent failure without leaving a sleep pending', async () => {
    const time = fakeTime()
    let queries = 0

    await expect(
      pollTestNodeOutboxDelivery('target', 'attachment delivery', 10_000, {
        queryRows: async () => {
          queries++
          return [row('failed', 3, 'HTTP 404')]
        },
        ...time,
        intervalMs: 750,
        diagnostics: () => 'serve process cleaned up',
      })
    ).rejects.toThrow('delivery failed after 3 attempt(s): HTTP 404')

    expect(queries).toBe(1)
    expect(time.sleeps).toEqual([])
  })
})
