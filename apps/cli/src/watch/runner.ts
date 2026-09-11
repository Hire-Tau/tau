import { encodeCursor } from './cursor'
import { diffSnapshots, healthDegraded, healthRecovered, type IdleState, type WatchEvent } from './diff'
import type { Snapshot } from './snapshot'
import type { HintSocket } from './ws'

export interface WatchResult {
  at: string
  cursor: string
  events: WatchEvent[]
}

export interface RunnerDeps {
  fetchSnapshot: () => Promise<Snapshot>
  openSocket: (onHint: () => void, onError: (message: string) => void) => HintSocket | null
  emit: (result: WatchResult) => void
  warn: (message: string) => void
  now: () => number
  follow: boolean
  pollMs: number
  timeoutMs?: number
  debounceMs?: number
  initial?: Snapshot
}

const FAILURES_BEFORE_DEGRADED = 3

/**
 * Baseline → wait for a trigger (socket hint, poll timer) → re-snapshot → diff.
 * A trigger whose diff is empty is not a change: --once keeps waiting.
 */
export async function runWatch(deps: RunnerDeps): Promise<void> {
  const debounceMs = deps.debounceMs ?? 500
  const idle: IdleState | undefined = deps.follow ? { since: {}, notified: [] } : undefined
  let current = deps.initial ?? (await deps.fetchSnapshot())
  let failures = 0
  let unhealthy = false
  let checking = false
  let pending = false
  let debounce: ReturnType<typeof setTimeout> | null = null
  let finished = false

  return new Promise<void>((resolve) => {
    const socket = deps.openSocket(schedule, (message) => deps.warn(`websocket: ${message}`))
    const poll = setInterval(schedule, deps.pollMs)
    const deadline =
      deps.timeoutMs && !deps.follow
        ? setTimeout(
            () => finish({ at: new Date(deps.now()).toISOString(), cursor: encodeCursor(current), events: [] }),
            deps.timeoutMs
          )
        : null

    function finish(result?: WatchResult) {
      if (finished) return
      finished = true
      if (debounce) clearTimeout(debounce)
      clearInterval(poll)
      if (deadline) clearTimeout(deadline)
      socket?.close()
      if (result) deps.emit(result)
      resolve()
    }

    function schedule() {
      if (finished) return
      if (debounce) return
      debounce = setTimeout(() => {
        debounce = null
        void check()
      }, debounceMs)
    }

    async function check() {
      if (finished) return
      if (checking) {
        pending = true
        return
      }
      checking = true
      try {
        const events: WatchEvent[] = []
        let next: Snapshot
        try {
          next = await deps.fetchSnapshot()
        } catch (error) {
          failures += 1
          if (failures >= FAILURES_BEFORE_DEGRADED && !unhealthy) {
            unhealthy = true
            events.push(healthDegraded(error instanceof Error ? error.message : String(error)))
          }
          if (events.length) deliver(events)
          return
        }
        if (unhealthy) events.push(healthRecovered())
        failures = 0
        unhealthy = false
        events.push(...diffSnapshots(current, next, { now: deps.now(), idle }))
        current = next
        if (events.length) deliver(events)
      } finally {
        checking = false
        if (pending && !finished) {
          pending = false
          schedule()
        }
      }
    }

    function deliver(events: WatchEvent[]) {
      const result: WatchResult = { at: new Date(deps.now()).toISOString(), cursor: encodeCursor(current), events }
      if (deps.follow) deps.emit(result)
      else finish(result)
    }
  })
}
