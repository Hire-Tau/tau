import { describe, expect, it } from 'bun:test'
import { createControlledWorkerSSE } from './controlled-worker-sse.test-helper'

describe('createControlledWorkerSSE', () => {
  it('captures signals only for exact predeclared worker paths', async () => {
    const harness = createControlledWorkerSSE(['/stream/execution-a', '/stream/execution-b'])
    const a = harness.connection('/stream/execution-a')
    const b = harness.connection('/stream/execution-b')
    const aSignal = new AbortController().signal
    const bSignal = new AbortController().signal

    await harness.fetch('http://worker/stream/execution-a', { signal: aSignal })
    await harness.fetch('http://worker/stream/execution-b', { signal: bSignal })
    await Promise.all([a.started, b.started])

    expect(a.signal).toBe(aSignal)
    expect(b.signal).toBe(bSignal)
    expect(a.signal).not.toBe(b.signal)
    await expect(harness.fetch('http://worker/stream/unknown')).rejects.toThrow(
      'Unexpected worker SSE path: /stream/unknown'
    )
  })

  it('exposes controlled cancellation barriers for each connection', async () => {
    const harness = createControlledWorkerSSE(['/stream/execution-a'])
    const connection = harness.connection('/stream/execution-a')
    const response = await harness.fetch('http://worker/stream/execution-a')
    const reader = response.body!.getReader()

    const cancelling = reader.cancel()
    await connection.cancelStarted
    let settled = false
    void cancelling.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    connection.releaseCancel()
    await Promise.all([cancelling, connection.cancelSettled])
    expect(settled).toBe(true)
  })

  it('rejects duplicate connection attempts', async () => {
    const harness = createControlledWorkerSSE(['/stream/execution-a'])
    await harness.fetch('http://worker/stream/execution-a')

    await expect(harness.fetch('http://worker/stream/execution-a')).rejects.toThrow(
      'Duplicate worker SSE connection: /stream/execution-a'
    )
  })
})
