type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface ProtocolProbe {
  url: string
  validate: (
    response: Response
  ) => boolean | { valid: boolean; detail?: string } | Promise<boolean | { valid: boolean; detail?: string }>
}

interface ProtocolReadyOptions {
  phase: string
  timeoutMs: number
  probes: ProtocolProbe[]
  diagnostics?: () => string | Promise<string>
  isDead?: () => boolean
  signal?: AbortSignal
}

interface ProtocolReadyDependencies {
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout> | number
  clearTimeout?: (timer: ReturnType<typeof setTimeout> | number) => void
  fetch: FetchFunction
  now: () => number
  sleep: (ms: number) => Promise<unknown>
}

const defaultDependencies: ProtocolReadyDependencies = {
  fetch: globalThis.fetch.bind(globalThis),
  now: Date.now,
  sleep: Bun.sleep,
}

export class ProtocolPhaseError extends Error {
  readonly code = 'PROTOCOL_PHASE_FAILED'

  constructor(
    readonly phase: string,
    message: string
  ) {
    super(`${phase}: ${message}`)
    this.name = 'ProtocolPhaseError'
  }
}

export async function fetchInProtocolPhase(
  url: string,
  options: {
    phase: string
    timeoutMs: number
    init?: RequestInit
    requireOk?: boolean
    diagnostics?: () => string | Promise<string>
  },
  fetchImpl: FetchFunction = globalThis.fetch.bind(globalThis)
): Promise<Response> {
  try {
    const response = await fetchImpl(url, {
      ...options.init,
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    if (options.requireOk && !response.ok) {
      await cancelResponseBody(response)
      throw new ProtocolPhaseError(
        options.phase,
        `${url} returned status=${response.status}${await formatDiagnostics(options.diagnostics)}`
      )
    }
    return response
  } catch (error) {
    if (error instanceof ProtocolPhaseError) throw error
    throw new ProtocolPhaseError(
      options.phase,
      `${url} failed within ${options.timeoutMs}ms: ${error instanceof Error ? error.message : String(error)}` +
        (await formatDiagnostics(options.diagnostics))
    )
  }
}

/** Waits until every HTTP probe succeeds in order within one shared deadline. */
async function formatDiagnostics(diagnostics?: () => string | Promise<string>): Promise<string> {
  const detail = await diagnostics?.()
  return detail ? `; ${detail}` : ''
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) throw signal.reason
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export async function waitForProtocolReady(
  options: ProtocolReadyOptions,
  dependencies: ProtocolReadyDependencies = defaultDependencies
): Promise<void> {
  const deadline = dependencies.now() + options.timeoutMs
  let lastFailure = 'no probe completed'

  while (dependencies.now() < deadline) {
    if (options.signal?.aborted) {
      throw new ProtocolPhaseError(
        options.phase,
        `cancelled before readiness${await formatDiagnostics(options.diagnostics)}`
      )
    }
    if (options.isDead?.()) {
      throw new ProtocolPhaseError(
        options.phase,
        `child exited before readiness${await formatDiagnostics(options.diagnostics)}`
      )
    }
    let ready = true
    for (const probe of options.probes) {
      const remainingMs = deadline - dependencies.now()
      if (remainingMs <= 0) {
        ready = false
        break
      }
      try {
        const attempt = new AbortController()
        const onParentAbort = () => attempt.abort(options.signal?.reason)
        options.signal?.addEventListener('abort', onParentAbort, { once: true })
        const timer = (dependencies.setTimeout ?? setTimeout)(
          () => attempt.abort('readiness attempt timed out'),
          Math.max(1, Math.min(1_000, remainingMs))
        )
        let response: Response
        try {
          response = await awaitWithSignal(dependencies.fetch(probe.url, { signal: attempt.signal }), attempt.signal)
        } catch (error) {
          ;(dependencies.clearTimeout ?? clearTimeout)(timer)
          throw error
        } finally {
          options.signal?.removeEventListener('abort', onParentAbort)
        }
        if (!response.ok) {
          ;(dependencies.clearTimeout ?? clearTimeout)(timer)
          await cancelResponseBody(response)
          lastFailure = `${probe.url} returned status=${response.status}`
          ready = false
          break
        }
        let validation: boolean | { valid: boolean; detail?: string } = false
        try {
          validation = await awaitWithSignal(Promise.resolve(probe.validate(response)), attempt.signal)
        } catch (error) {
          await cancelResponseBody(response)
          throw error
        } finally {
          ;(dependencies.clearTimeout ?? clearTimeout)(timer)
        }
        const valid = typeof validation === 'boolean' ? validation : validation.valid
        if (!valid) {
          await cancelResponseBody(response)
          const detail = typeof validation === 'boolean' ? undefined : validation.detail
          lastFailure = `${probe.url} returned an invalid payload${detail ? ` (${detail})` : ''}`
          ready = false
          break
        }
      } catch (error) {
        lastFailure = `${probe.url}: ${error instanceof Error ? error.message : String(error)}`
        ready = false
        break
      }
    }
    if (ready) return
    if (options.signal?.aborted) {
      throw new ProtocolPhaseError(
        options.phase,
        `cancelled during readiness${await formatDiagnostics(options.diagnostics)}`
      )
    }

    const remainingMs = deadline - dependencies.now()
    if (remainingMs > 0) await dependencies.sleep(Math.min(50, remainingMs))
  }

  throw new ProtocolPhaseError(
    options.phase,
    `timed out after ${options.timeoutMs}ms; last failure=${lastFailure}${await formatDiagnostics(options.diagnostics)}`
  )
}
