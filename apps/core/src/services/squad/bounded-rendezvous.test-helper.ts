interface Waiter {
  resolve: () => void
  reject: (error: Error) => void
}

export interface RendezvousClock {
  setTimeout(callback: () => void, timeoutMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface BoundedRendezvous<Participant extends string> {
  arrive(participant: Participant): Promise<void>
  abort(participant: Participant, cause: unknown): void
  readonly pending: boolean
}

/**
 * A test-only, fail-fast rendezvous for deterministic race fixtures.
 * Every terminal path clears its timer and releases all current waiters.
 */
export function createBoundedRendezvous<Participant extends string>(
  participants: readonly Participant[],
  phase: string,
  timeoutMs: number,
  signal?: AbortSignal,
  clock: RendezvousClock = {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
): BoundedRendezvous<Participant> {
  const expected = new Set(participants)
  if (participants.length === 0 || expected.size !== participants.length) {
    throw new Error('Rendezvous participants must be non-empty and unique')
  }
  const arrived = new Set<Participant>()
  const waiters: Waiter[] = []
  let terminalError: Error | undefined
  let completed = false

  const names = (values: Iterable<Participant>) => [...values].join(', ')
  const missing = () => participants.filter((participant) => !arrived.has(participant))
  const cleanup = () => {
    clock.clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
  const settle = (error?: Error) => {
    if (completed || terminalError) return
    if (error) terminalError = error
    else completed = true
    cleanup()
    for (const waiter of waiters.splice(0)) {
      if (error) waiter.reject(error)
      else waiter.resolve()
    }
  }
  const diagnostic = () => `missing: ${names(missing())}; arrived: ${names(arrived)}`
  const cancel = () => {
    const reason = signal?.reason instanceof Error ? signal.reason.message : String(signal?.reason ?? 'aborted')
    settle(new Error(`Rendezvous cancelled in phase "${phase}"; ${diagnostic()}; reason: ${reason}`))
  }
  const timer = clock.setTimeout(() => {
    settle(new Error(`Rendezvous timed out in phase "${phase}"; ${diagnostic()}`))
  }, timeoutMs)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()

  return {
    arrive(participant) {
      if (completed) return Promise.resolve()
      if (terminalError) return Promise.reject(terminalError)
      if (!expected.has(participant)) {
        const error = new Error(`Unexpected rendezvous participant "${participant}" in phase "${phase}"`)
        settle(error)
        return Promise.reject(error)
      }
      if (arrived.has(participant)) {
        const error = new Error(`Duplicate rendezvous participant "${participant}" in phase "${phase}"`)
        settle(error)
        return Promise.reject(error)
      }

      arrived.add(participant)
      const promise = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }))
      if (arrived.size === expected.size) settle()
      return promise
    },
    abort(participant, cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      settle(new Error(`Rendezvous aborted in phase "${phase}" by ${participant}: ${message}`))
    },
    get pending() {
      return !completed && !terminalError
    },
  }
}
