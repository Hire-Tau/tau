import { describe, it, expect } from 'bun:test'
import { InflightDeduper, KeyedSerialQueue } from './inflight'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('InflightDeduper', () => {
  it('shares one in-flight promise across concurrent callers with the same key', async () => {
    const dedupe = new InflightDeduper<string>()
    const gate = deferred<string>()
    let calls = 0

    const a = dedupe.run('k', () => {
      calls++
      return gate.promise
    })
    const b = dedupe.run('k', () => {
      calls++
      return gate.promise
    })

    gate.resolve('result')
    expect(await a).toBe('result')
    expect(await b).toBe('result')
    expect(calls).toBe(1)
  })

  it('runs again after the previous call settles', async () => {
    const dedupe = new InflightDeduper<number>()
    let calls = 0
    const run = () =>
      dedupe.run('k', async () => {
        calls++
        return calls
      })

    expect(await run()).toBe(1)
    expect(await run()).toBe(2)
  })

  it('keys are independent', async () => {
    const dedupe = new InflightDeduper<string>()
    const gateA = deferred<string>()
    let calls = 0

    const a = dedupe.run('a', () => {
      calls++
      return gateA.promise
    })
    const b = dedupe.run('b', async () => {
      calls++
      return 'b-result'
    })

    expect(await b).toBe('b-result')
    gateA.resolve('a-result')
    expect(await a).toBe('a-result')
    expect(calls).toBe(2)
  })

  it('propagates rejection to all joiners and clears the entry', async () => {
    const dedupe = new InflightDeduper<string>()
    const gate = deferred<string>()

    const a = dedupe.run('k', () => gate.promise)
    const b = dedupe.run('k', () => gate.promise)

    gate.reject(new Error('boom'))
    await expect(a).rejects.toThrow('boom')
    await expect(b).rejects.toThrow('boom')

    // A new call runs fresh after the failure
    expect(await dedupe.run('k', async () => 'recovered')).toBe('recovered')
    expect(dedupe.size).toBe(0)
  })

  it('a synchronous throw in fn rejects the caller and clears the entry', async () => {
    const dedupe = new InflightDeduper<string>()
    await expect(
      dedupe.run('k', () => {
        throw new Error('sync boom')
      })
    ).rejects.toThrow('sync boom')
    expect(dedupe.size).toBe(0)
  })

  it('settled() resolves once all current in-flight runs settle, swallowing rejections', async () => {
    const dedupe = new InflightDeduper<string>()
    const gateA = deferred<string>()
    const gateB = deferred<string>()

    const a = dedupe.run('a', () => gateA.promise)
    const b = dedupe.run('b', () => gateB.promise)

    let settledDone = false
    const settledP = dedupe.settled().then(() => {
      settledDone = true
    })

    // Still parked on both runs.
    await Promise.resolve()
    expect(settledDone).toBe(false)

    gateA.resolve('a-done')
    gateB.reject(new Error('b-boom'))
    // settled() must not reject even though a run did.
    await settledP
    expect(settledDone).toBe(true)

    expect(await a).toBe('a-done')
    await expect(b).rejects.toThrow('b-boom')
  })

  it('settled() resolves immediately with nothing in flight', async () => {
    const dedupe = new InflightDeduper<string>()
    await dedupe.settled()
  })
})

describe('KeyedSerialQueue', () => {
  it('runs same-key tasks strictly in order without overlap', async () => {
    const queue = new KeyedSerialQueue()
    const events: string[] = []
    const gate = deferred<void>()

    const first = queue.run('k', async () => {
      events.push('first-start')
      await gate.promise
      events.push('first-end')
    })
    const second = queue.run('k', async () => {
      events.push('second-start')
    })

    // Second must not start while first is pending
    await new Promise((r) => setTimeout(r, 10))
    expect(events).toEqual(['first-start'])

    gate.resolve()
    await first
    await second
    expect(events).toEqual(['first-start', 'first-end', 'second-start'])
  })

  it('a rejected task does not break the chain, and the caller sees its own rejection', async () => {
    const queue = new KeyedSerialQueue()

    const failing = queue.run('k', async () => {
      throw new Error('task failed')
    })
    const following = queue.run('k', async () => 'ok')

    await expect(failing).rejects.toThrow('task failed')
    expect(await following).toBe('ok')
  })

  it('different keys run independently', async () => {
    const queue = new KeyedSerialQueue()
    const gate = deferred<void>()

    const blocked = queue.run('a', () => gate.promise)
    const free = queue.run('b', async () => 'b-done')

    expect(await free).toBe('b-done')
    gate.resolve()
    await blocked
  })

  it('cleans up the queue entry once drained', async () => {
    const queue = new KeyedSerialQueue()
    await queue.run('k', async () => 1)
    expect(queue.size).toBe(0)
  })

  it('returns each task its own result', async () => {
    const queue = new KeyedSerialQueue()
    const results = await Promise.all([queue.run('k', async () => 1), queue.run('k', async () => 2)])
    expect(results).toEqual([1, 2])
  })
})
