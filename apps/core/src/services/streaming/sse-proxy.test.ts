import { describe, expect, it, mock } from 'bun:test'
import { proxyWorkerSSE } from './sse-proxy'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await Promise.resolve()
  return settled
}

function workerSseResponse(): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: done\ndata: {"type":"done","response":"ok"}\n\n'))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

describe('proxyWorkerSSE', () => {
  it('observes rejected promise settlement without leaking the rejection', async () => {
    expect(await isSettled(Promise.reject(new Error('expected rejection')))).toBe(true)
  })

  it('does not fetch or write when revocation already aborted the stream', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = mock(async () => workerSseResponse())
    const writeSSE = mock(async () => {})
    await proxyWorkerSSE(
      { writeSSE } as any,
      { workerPath: '/stream/test-execution', signal: controller.signal },
      { fetch: fetchMock }
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(writeSSE).not.toHaveBeenCalled()
  })

  it('passes the revocation signal to the scoped worker fetch', async () => {
    const controller = new AbortController()
    const fetchWorker = mock(async () => workerSseResponse())

    await proxyWorkerSSE(
      { writeSSE: async () => {} } as any,
      {
        workerPath: '/stream/execution-a',
        signal: controller.signal,
      },
      { fetch: fetchWorker }
    )

    expect(fetchWorker).toHaveBeenCalledWith(expect.stringContaining('/stream/execution-a'), {
      signal: controller.signal,
    })
  })

  it('settles only after the selected reader cancellation settles', async () => {
    const controller = new AbortController()
    const fetchStarted = deferred<void>()
    const cancelStarted = deferred<void>()
    const releaseCancel = deferred<void>()
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelStarted.resolve()
          return releaseCancel.promise
        },
      })
    )
    const running = proxyWorkerSSE(
      { writeSSE: async () => {} } as any,
      { workerPath: '/stream/exact', signal: controller.signal },
      {
        fetch: async () => {
          fetchStarted.resolve()
          return response
        },
      }
    )

    await fetchStarted.promise
    controller.abort()
    await cancelStarted.promise
    expect(controller.signal.aborted).toBe(true)
    expect(await isSettled(running)).toBe(false)
    releaseCancel.resolve()
    await running
  })

  it('forwards ping events as keepalives instead of dropping them', async () => {
    const encoder = new TextEncoder()
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: ping\ndata: \n\n'))
          controller.enqueue(encoder.encode('event: text\ndata: {"type":"text","text":"hi"}\n\n'))
          controller.enqueue(encoder.encode('event: done\ndata: \n\n'))
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )

    const fetchWorker = mock(async () => response)

    const writes: Array<{ event?: string; data?: string }> = []
    await proxyWorkerSSE(
      {
        writeSSE: async (entry: { event?: string; data?: string }) => {
          writes.push(entry)
        },
      } as any,
      { workerPath: '/stream/test-execution' },
      { fetch: fetchWorker }
    )

    expect(writes).toContainEqual({ event: 'ping', data: '' })
    expect(writes).toContainEqual({ event: 'text', data: '{"type":"text","text":"hi"}' })
    expect(writes).toContainEqual({ event: 'done', data: '' })
  })

  it('still honours skipEvents for explicit suppression', async () => {
    const encoder = new TextEncoder()
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: noisy\ndata: x\n\n'))
          controller.enqueue(encoder.encode('event: done\ndata: \n\n'))
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )

    const fetchWorker = mock(async () => response)

    const writes: Array<{ event?: string; data?: string }> = []
    await proxyWorkerSSE(
      {
        writeSSE: async (entry: { event?: string; data?: string }) => {
          writes.push(entry)
        },
      } as any,
      { workerPath: '/stream/test-execution', skipEvents: new Set(['noisy']) },
      { fetch: fetchWorker }
    )

    expect(writes.find((write) => write.event === 'noisy')).toBeUndefined()
    expect(writes).toContainEqual({ event: 'done', data: '' })
  })

  it('keeps waiting long enough for worker poll fallback to create a delayed stream', async () => {
    let attempts = 0
    const fetchWorker = mock(async () => {
      attempts += 1
      return attempts <= 50 ? new Response('{"error":"Stream not found"}', { status: 404 }) : workerSseResponse()
    })

    const writes: Array<{ event?: string; data?: string }> = []
    await proxyWorkerSSE(
      {
        writeSSE: async (entry: { event?: string; data?: string }) => {
          writes.push(entry)
        },
      } as any,
      { workerPath: '/stream/test-execution' },
      { fetch: fetchWorker, delay: async () => {} }
    )

    expect(attempts).toBe(51)
    expect(writes).toContainEqual({ event: 'done', data: '{"type":"done","response":"ok"}' })
    expect(writes).not.toContainEqual({
      event: 'error',
      data: JSON.stringify({ type: 'error', message: 'Worker stream not ready' }),
    })
  })
})
