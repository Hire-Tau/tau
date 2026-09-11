export interface ExecutionLifecycle {
  readonly executionId: string
  readonly agentId: string
  readonly generationAtClaim: number
  interruptRequested: boolean
  runnerStarted: boolean
  readonly settled: Promise<void>
  readonly runnerFinished: Promise<void>
  requestMaintenanceInterrupt(): Promise<void>
  resetMaintenanceInterruptAttempt(): void
  attachQuiesce(callback: () => Promise<void>): void
  attachFallbackSettlement(callback: () => Promise<void>): void
  runFallbackSettlement(): Promise<boolean>
  markRunnerStarted(): void
  markRunnerFinished(): void
  settle(): void
}

class Lifecycle implements ExecutionLifecycle {
  interruptRequested = false
  runnerStarted = false
  readonly settled: Promise<void>
  readonly runnerFinished: Promise<void>
  private resolveSettled!: () => void
  private resolveRunnerFinished!: () => void
  private readonly quiesceCallbacks: Array<() => Promise<void>> = []
  private fallbackSettlement: (() => Promise<void>) | null = null
  private interrupting: Promise<void> | null = null
  private isSettled = false
  private isRunnerFinished = false

  constructor(
    readonly executionId: string,
    readonly agentId: string,
    readonly generationAtClaim: number,
    private readonly onSettled: () => void
  ) {
    this.settled = new Promise((resolve) => (this.resolveSettled = resolve))
    this.runnerFinished = new Promise((resolve) => (this.resolveRunnerFinished = resolve))
  }

  attachQuiesce(callback: () => Promise<void>): void {
    let invoked = false
    this.quiesceCallbacks.push(() => {
      if (invoked) return Promise.resolve()
      invoked = true
      return callback()
    })
    if (this.interruptRequested) void this.runQuiesce()
  }

  attachFallbackSettlement(callback: () => Promise<void>): void {
    this.fallbackSettlement = callback
  }

  async runFallbackSettlement(): Promise<boolean> {
    if (!this.fallbackSettlement) return false
    await this.fallbackSettlement()
    return true
  }

  requestMaintenanceInterrupt(): Promise<void> {
    this.interruptRequested = true
    return this.runQuiesce()
  }

  resetMaintenanceInterruptAttempt(): void {
    this.interrupting = null
  }

  markRunnerStarted(): void {
    this.runnerStarted = true
  }

  markRunnerFinished(): void {
    if (this.isRunnerFinished) return
    this.isRunnerFinished = true
    this.resolveRunnerFinished()
    if (this.isSettled) this.onSettled()
  }

  settle(): void {
    if (this.isSettled) return
    this.isSettled = true
    this.resolveSettled()
    if (this.isRunnerFinished) this.onSettled()
  }

  private runQuiesce(): Promise<void> {
    if (this.quiesceCallbacks.length === 0) return Promise.resolve()
    if (!this.interrupting) {
      const attempt = Promise.all(this.quiesceCallbacks.map((callback) => callback())).then(() => undefined)
      const wrapped = attempt.catch((error) => {
        // Attempt A may reject after a timeout reset and attempt B started.
        // Never let A clear B's in-flight ownership.
        if (this.interrupting === wrapped) this.interrupting = null
        throw error
      })
      this.interrupting = wrapped
    }
    return this.interrupting
  }
}

export class ExecutionLifecycleRegistry {
  private readonly entries = new Map<string, ExecutionLifecycle>()

  registerProvisional(executionId: string, agentId: string, generationAtClaim: number): ExecutionLifecycle {
    const existing = this.entries.get(executionId)
    if (existing) return existing
    const lifecycle = new Lifecycle(executionId, agentId, generationAtClaim, () => this.entries.delete(executionId))
    this.entries.set(executionId, lifecycle)
    return lifecycle
  }

  get(executionId: string): ExecutionLifecycle | undefined {
    return this.entries.get(executionId)
  }

  list(): ExecutionLifecycle[] {
    return [...this.entries.values()]
  }
}

export const executionLifecycleRegistry = new ExecutionLifecycleRegistry()
