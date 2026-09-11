export interface LifecycleSnapshot {
  children: number
  waits: number
  timers: number
  abortListeners: number
  operations: string[]
}

export const zeroLifecycleSnapshot: LifecycleSnapshot = {
  children: 0,
  waits: 0,
  timers: 0,
  abortListeners: 0,
  operations: [],
}

export class LifecycleLedger {
  private waits = 0
  private timers = 0
  private abortListeners = 0
  private children = 0
  private readonly operations = new Set<string>()

  registerChild(): () => void {
    this.children++
    let active = true
    return () => {
      if (!active) return
      active = false
      this.children--
    }
  }

  registerOperation(operationId: string): () => void {
    if (this.operations.has(operationId)) throw new Error(`duplicate lifecycle operation: ${operationId}`)
    this.operations.add(operationId)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.operations.delete(operationId)
    }
  }

  registerWait(): () => void {
    this.waits++
    this.timers++
    this.abortListeners++
    let active = true
    return () => {
      if (!active) return
      active = false
      this.waits--
      this.timers--
      this.abortListeners--
    }
  }

  snapshot(): LifecycleSnapshot {
    return {
      children: this.children,
      waits: this.waits,
      timers: this.timers,
      abortListeners: this.abortListeners,
      operations: [...this.operations].sort(),
    }
  }

  assertZero(owner: string): void {
    const snapshot = this.snapshot()
    if (JSON.stringify(snapshot) !== JSON.stringify(zeroLifecycleSnapshot)) {
      throw new Error(`${owner} leaked lifecycle resources: ${JSON.stringify(snapshot)}`)
    }
  }
}

export interface LifecycleClock {
  now(): number
  sleep(ms: number, signal: AbortSignal, ledger: LifecycleLedger): Promise<void>
}

interface ManualWait {
  dueAt: number
  settle(): void
}

function abortError(signal: AbortSignal): DOMException {
  return new DOMException(String(signal.reason ?? 'Operation aborted'), 'AbortError')
}

export class ManualLifecycleClock implements LifecycleClock {
  private time = 0
  private readonly waits = new Set<ManualWait>()

  now(): number {
    return this.time
  }

  sleep(ms: number, signal: AbortSignal, ledger: LifecycleLedger): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError(signal))
    const unregister = ledger.registerWait()
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        this.waits.delete(wait)
        signal.removeEventListener('abort', onAbort)
        unregister()
        if (error) reject(error)
        else resolve()
      }
      const onAbort = () => finish(abortError(signal))
      const wait: ManualWait = { dueAt: this.time + Math.max(0, ms), settle: () => finish() }
      this.waits.add(wait)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  advanceBy(ms: number): void {
    this.time += ms
    for (const wait of [...this.waits]) if (wait.dueAt <= this.time) wait.settle()
  }

  pendingCount(): number {
    return this.waits.size
  }
}

export class Deadline {
  constructor(
    private readonly clock: Pick<LifecycleClock, 'now'>,
    readonly expiresAt: number
  ) {}

  remainingMs(): number {
    return Math.max(0, this.expiresAt - this.clock.now())
  }

  child(maxMs: number, reserveMs = 0): Deadline {
    return new Deadline(
      this.clock,
      Math.max(this.clock.now(), Math.min(this.expiresAt - reserveMs, this.clock.now() + maxMs))
    )
  }
}

export function deadlineAt(clock: Pick<LifecycleClock, 'now'>, expiresAt: number): Deadline {
  return new Deadline(clock, expiresAt)
}
