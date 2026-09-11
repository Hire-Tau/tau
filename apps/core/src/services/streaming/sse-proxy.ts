import type { Context } from 'hono'
import type { SSEStreamingApi } from 'hono/streaming'
import { getWorkerUrl } from '../worker'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('sse-proxy')

const POLL_INTERVAL_MS = 100
// Worker execution pickup has a polling fallback for missed DB notifications.
// Keep the chat SSE bridge open long enough for that fallback to create the
// stream buffer, otherwise the frontend can show a stale queued/errored state
// even though the execution completes shortly after.
const MAX_POLL_ATTEMPTS = 450 // 45 seconds max wait for stream to become ready

type SSEWrite = Parameters<SSEStreamingApi['writeSSE']>[0]

export interface ProxySSEOptions {
  /** Worker stream path, e.g. `/stream/${runId}` or `/chat-stream/${runId}` */
  workerPath: string
  /** SSE event names to skip when forwarding */
  skipEvents?: Set<string>
  signal?: AbortSignal
}

export interface ProxyWorkerSSEDependencies {
  fetch: (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>
  delay: (ms: number, signal?: AbortSignal) => Promise<void>
}

const defaultDependencies: ProxyWorkerSSEDependencies = {
  fetch: (...args) => globalThis.fetch(...args),
  delay: abortableDelay,
}

export type ProxyWorkerSSE = typeof proxyWorkerSSE

declare module 'hono' {
  interface ContextVariableMap {
    proxyWorkerSSE?: ProxyWorkerSSE
  }
}

export function getProxyWorkerSSE(c: Context): ProxyWorkerSSE {
  return c.get('proxyWorkerSSE') ?? proxyWorkerSSE
}

/**
 * Connect to a worker SSE stream with retries, then proxy events
 * through to the client via `stream.writeSSE()`.
 *
 * Reuses the first successful response directly (no double-fetch).
 * Used by execution stream endpoints.
 */
export async function proxyWorkerSSE(
  stream: SSEStreamingApi,
  opts: ProxySSEOptions,
  dependencies: Partial<ProxyWorkerSSEDependencies> = {}
): Promise<void> {
  const deps = { ...defaultDependencies, ...dependencies }
  const workerUrl = getWorkerUrl()
  const url = `${workerUrl}${opts.workerPath}`
  const writeEvent = async (event: SSEWrite): Promise<void> => {
    await stream.writeSSE(event)
  }

  // Connect with retries — reuse the first successful response
  let workerResponse: Response | null = null
  let attempts = 0

  while (!workerResponse && attempts < MAX_POLL_ATTEMPTS && !opts.signal?.aborted) {
    try {
      const response = await deps.fetch(url, { signal: opts.signal })
      if (response.ok && response.body) {
        workerResponse = response
      } else {
        await deps.delay(POLL_INTERVAL_MS, opts.signal)
        attempts++
      }
    } catch {
      if (opts.signal?.aborted) return
      await deps.delay(POLL_INTERVAL_MS, opts.signal)
      attempts++
    }
  }

  if (!workerResponse) {
    if (opts.signal?.aborted) return
    await writeEvent({
      event: 'error',
      data: JSON.stringify({ type: 'error', message: 'Worker stream not ready' }),
    })
    return
  }

  const reader = workerResponse.body!.getReader()
  let cancellation: Promise<void> | undefined
  const cancelReader = () => (cancellation ??= reader.cancel().catch(() => {}))
  const abortReader = () => void cancelReader()
  opts.signal?.addEventListener('abort', abortReader, { once: true })
  try {
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done || opts.signal?.aborted) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7)
        } else if (line.startsWith('data: ')) {
          const raw = line.slice(6)
          if (opts.skipEvents?.has(currentEvent)) {
            continue
          }
          // Hono's writeSSE omits the event field when event is ''.
          // Fall back to 'message' (SSE default) so the field is always present.
          await writeEvent({
            event: currentEvent || 'message',
            data: raw,
          })
        } else if (line === '') {
          // Blank line = SSE event boundary, reset for next event
          currentEvent = ''
        }
      }
    }
  } catch (error) {
    if (opts.signal?.aborted) return
    log.error('Error proxying worker stream:', error)
    await writeEvent({
      event: 'error',
      data: JSON.stringify({ type: 'error', message: 'Stream connection lost' }),
    })
  } finally {
    opts.signal?.removeEventListener('abort', abortReader)
    await cancelReader()
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })
}
