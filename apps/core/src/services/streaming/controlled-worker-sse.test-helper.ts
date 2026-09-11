interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

export interface ControlledWorkerSSEConnection {
  readonly path: string
  readonly signal: AbortSignal | null | undefined
  readonly started: Promise<void>
  readonly cancelStarted: Promise<void>
  readonly cancelSettled: Promise<void>
  releaseCancel(): void
}

export interface ControlledWorkerSSE {
  fetch: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>
  connection(path: string): ControlledWorkerSSEConnection
}

interface ConnectionState {
  path: string
  signal: AbortSignal | null | undefined
  connected: boolean
  started: Deferred
  cancelStarted: Deferred
  cancelSettled: Deferred
  cancelRelease: Deferred
}

/**
 * Creates a strict worker-SSE transport for route tests.
 *
 * Every accepted path must be declared before the request. Unknown paths and
 * duplicate attempts fail immediately so a generic fetch cannot accidentally
 * satisfy another stream's connection barrier.
 */
export function createControlledWorkerSSE(paths: readonly string[]): ControlledWorkerSSE {
  const states = new Map<string, ConnectionState>()
  for (const path of paths) {
    if (states.has(path)) throw new Error(`Duplicate worker SSE path: ${path}`)
    states.set(path, {
      path,
      signal: undefined,
      connected: false,
      started: deferred(),
      cancelStarted: deferred(),
      cancelSettled: deferred(),
      cancelRelease: deferred(),
    })
  }

  const connection = (path: string): ControlledWorkerSSEConnection => {
    const state = states.get(path)
    if (!state) throw new Error(`Unexpected worker SSE path: ${path}`)
    return {
      path,
      get signal() {
        return state.signal
      },
      started: state.started.promise,
      cancelStarted: state.cancelStarted.promise,
      cancelSettled: state.cancelSettled.promise,
      releaseCancel: state.cancelRelease.resolve,
    }
  }

  const fetchWorker: ControlledWorkerSSE['fetch'] = async (input, init) => {
    const path = new URL(String(input)).pathname
    const state = states.get(path)
    if (!state) throw new Error(`Unexpected worker SSE path: ${path}`)
    if (state.connected) throw new Error(`Duplicate worker SSE connection: ${path}`)

    state.connected = true
    state.signal = init?.signal
    state.started.resolve()
    return new Response(
      new ReadableStream({
        async cancel() {
          state.cancelStarted.resolve()
          await state.cancelRelease.promise
          state.cancelSettled.resolve()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )
  }

  return { fetch: fetchWorker, connection }
}
