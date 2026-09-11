import { describe, expect, it } from 'bun:test'
import { mapWithConcurrency } from './mapWithConcurrency'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('mapWithConcurrency', () => {
  it('returns results in INPUT order, not completion order', async () => {
    // Later items resolve sooner; result order must still track input order.
    const results = await mapWithConcurrency([30, 20, 10, 0], 4, async (ms, i) => {
      await delay(ms)
      return i
    })
    expect(results).toEqual([0, 1, 2, 3])
  })

  it('runs at most `concurrency` invocations in flight at once', async () => {
    let active = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      active++
      peak = Math.max(peak, active)
      await delay(5)
      active--
    })
    expect(peak).toBe(2)
  })

  it('actually parallelizes up to the cap (does not serialize)', async () => {
    const gate = deferred<void>()
    let started = 0
    const promise = mapWithConcurrency([1, 2, 3], 3, async () => {
      started++
      await gate.promise
    })
    await delay(1)
    expect(started).toBe(3) // all three admitted before any resolves
    gate.resolve()
    await promise
  })

  it('treats concurrency < 1 as 1 (serial)', async () => {
    let active = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3], 0, async () => {
      active++
      peak = Math.max(peak, active)
      await delay(2)
      active--
    })
    expect(peak).toBe(1)
  })

  it('resolves to an empty array for empty input without invoking fn', async () => {
    let calls = 0
    const results = await mapWithConcurrency([], 5, async () => {
      calls++
      return 1
    })
    expect(results).toEqual([])
    expect(calls).toBe(0)
  })
})
