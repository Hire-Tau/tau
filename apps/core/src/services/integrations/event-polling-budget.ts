import type { EventPollingSignal } from './types'

export class EventPollingBudgetExceededError extends Error {
  readonly code = 'event_polling_budget_exceeded'
  constructor() {
    super('Event polling request budget exhausted')
    this.name = 'EventPollingBudgetExceededError'
  }
}

export interface EventPollingBudget {
  readonly signal: EventPollingSignal
  readonly consumed: number
  readonly remaining: number
}

export function createEventPollingBudget(maxUnits: number): EventPollingBudget {
  const controller = new AbortController()
  let consumed = 0
  let remaining = Number.isFinite(maxUnits) ? Math.max(0, Math.floor(maxUnits)) : Number.POSITIVE_INFINITY
  const signal = controller.signal as EventPollingSignal
  Object.defineProperties(signal, {
    remainingBudgetUnits: { enumerable: true, get: () => remaining },
    reserveRequest: {
      enumerable: true,
      value: (units = 1) => {
        if (!Number.isFinite(units) || units <= 0) {
          consumed += remaining
          remaining = 0
          throw new EventPollingBudgetExceededError()
        }
        if (!Number.isFinite(remaining)) return
        const normalized = Math.ceil(units)
        if (normalized > remaining) throw new EventPollingBudgetExceededError()
        remaining -= normalized
        consumed += normalized
      },
    },
  })
  return {
    signal,
    get consumed() {
      return consumed
    },
    get remaining() {
      return remaining
    },
  }
}

/** @deprecated Adapters should call the typed signal.reserveRequest contract directly. */
export function consumeEventPollingBudget(signal?: EventPollingSignal, units = 1): void {
  signal?.reserveRequest(units)
}
