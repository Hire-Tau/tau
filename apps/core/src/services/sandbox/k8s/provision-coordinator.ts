import { randomUUID } from 'crypto'
import type { ProvisionConfig } from './provision-config'
import { SandboxProvisionError } from './provision-errors'
import { classifyProvisionFailure } from './provision-failure'
import type { OperationKind, OwnedAttempt, ProvisionStore, ProvisionTransition } from './provision-store'

export interface CoordinatorRunInput<T> {
  scope: string
  sandboxKey: string
  operationKind: OperationKind
  desiredSpecHash: string
  signal?: AbortSignal
  provision(signal: AbortSignal): Promise<{ podName: string; resultSpecHash: string; value?: T }>
  attach(podName: string, signal: AbortSignal): Promise<T>
}

type Entry = { promise: Promise<unknown>; waiters: number }
type Sleep = (ms: number, signal: AbortSignal) => Promise<void>

const abortError = () => new DOMException('The operation was aborted.', 'AbortError')
/**
 * Message for a shared attempt this process observed rather than ran itself.
 *
 * `executions.error` is the only provisioning diagnostic most operators ever see,
 * so it must distinguish the two ways a provision "fails" and must not discard a
 * `failureCode` the store already knows. Codes are a closed vocabulary from
 * `ProvisionFailureCode`, never free text, so appending one cannot leak a payload.
 */
export function observedFailureMessage(status: 'failed' | 'cancelled', failureCode?: string): string {
  const outcome = status === 'cancelled' ? 'was cancelled' : 'failed'
  const reason = failureCode ? ` (${failureCode})` : ''
  return `Sandbox provisioning ${outcome} in a concurrent attempt${reason}.`
}

export const defaultProvisionSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? abortError())
    const cleanup = () => signal.removeEventListener('abort', abort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    timer.unref?.()
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      reject(signal.reason ?? abortError())
    }
    signal.addEventListener('abort', abort, { once: true })
  })

export class ProvisionCoordinator {
  private readonly operations = new Map<string, Entry>()
  private readonly owned = new Map<string, OwnedAttempt>()
  private readonly controller = new AbortController()
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private shuttingDown = false
  private readonly openCache = new Map<string, { until: number; reasonCode?: string; circuitVersion?: number }>()
  private readonly counters = {
    attempts: 0,
    joins: 0,
    successes: 0,
    failures: 0,
    busyRejects: 0,
    openRejects: 0,
    opens: 0,
    halfOpens: 0,
    closes: 0,
    ownershipLosses: 0,
  }

  constructor(
    private readonly options: {
      store: ProvisionStore
      config: ProvisionConfig
      ownerId: string
      sleep?: Sleep
      onTransition?: (event: ProvisionTransition) => void
    }
  ) {}

  async run<T>(input: CoordinatorRunInput<T>): Promise<T> {
    if (this.shuttingDown)
      throw new SandboxProvisionError('SANDBOX_PROVISION_BUSY', 'Sandbox provisioning is shutting down.', 5_000)
    const key = `${input.scope}\0${input.sandboxKey}`
    let entry = this.operations.get(key)
    if (entry) {
      if (entry.waiters >= this.options.config.maxWaiters)
        throw new SandboxProvisionError(
          'SANDBOX_PROVISION_BUSY',
          'Too many callers are waiting for this sandbox.',
          5_000
        )
      entry.waiters++
    } else {
      const promise = this.execute(input)
      entry = { promise, waiters: 1 }
      this.operations.set(key, entry)
      void promise
        .finally(() => {
          if (this.operations.get(key)?.promise === promise) this.operations.delete(key)
        })
        .catch(() => {})
    }
    try {
      return await this.waitForCaller(entry.promise as Promise<T>, input.signal)
    } finally {
      entry.waiters--
    }
  }

  private async execute<T>(input: CoordinatorRunInput<T>): Promise<T> {
    const refusalId = randomUUID()
    this.rejectFromOpenCache(input, refusalId)
    let claim
    try {
      claim = await this.options.store.claim({
        scope: input.scope,
        sandboxKey: input.sandboxKey,
        operationKind: input.operationKind,
        desiredSpecHash: input.desiredSpecHash,
        ownerId: this.options.ownerId,
      })
    } catch (error) {
      if (error instanceof SandboxProvisionError) {
        throw this.provisionError(input, refusalId, error.code, error.message, error.retryAfterMs)
      }
      throw error
    }
    if (claim.kind === 'busy') {
      this.counters.busyRejects++
      throw this.provisionError(
        input,
        refusalId,
        'SANDBOX_PROVISION_BUSY',
        'Sandbox provisioning is at capacity.',
        claim.retryAfterMs,
        undefined,
        claim.controlVersion
      )
    }
    if (claim.kind === 'open') {
      this.cacheOpen(input.scope, claim.retryAfterMs, claim.reasonCode, claim.controlVersion)
      this.counters.openRejects++
      throw this.provisionError(
        input,
        refusalId,
        'SANDBOX_PROVISION_UNAVAILABLE',
        'Sandbox scheduling is temporarily unavailable.',
        claim.retryAfterMs,
        claim.reasonCode,
        claim.controlVersion
      )
    }
    if (claim.kind === 'join') {
      this.counters.joins++
      return this.observe(input, claim.attempt, refusalId, claim.controlVersion)
    }

    this.counters.attempts++
    if (claim.transition) this.recordTransition(input.scope, claim.transition)
    this.owned.set(claim.attempt.attemptId, claim.attempt)
    this.startHeartbeat()
    try {
      const result = await input.provision(this.controller.signal)
      const completion = await this.options.store.complete({
        attempt: claim.attempt,
        kind: 'success',
        podName: result.podName,
        resultSpecHash: result.resultSpecHash,
      })
      if (!completion.accepted)
        throw this.provisionError(
          input,
          refusalId,
          'SANDBOX_PROVISION_BUSY',
          'Sandbox provisioning ownership expired.',
          5_000,
          undefined,
          completion.controlVersion ?? claim.controlVersion
        )
      this.counters.successes++
      if (completion.transition) this.recordTransition(input.scope, completion.transition)
      return result.value ?? (result.podName as T)
    } catch (error) {
      this.counters.failures++
      const failure = classifyProvisionFailure(error)
      const completion = await this.options.store
        .complete({ attempt: claim.attempt, kind: 'failure', failureCode: failure.code })
        .catch(() => ({ accepted: false, controlVersion: undefined, transition: undefined }))
      if (completion.accepted && completion.transition) {
        this.recordTransition(input.scope, completion.transition)
      }
      if (error instanceof SandboxProvisionError || failure.code === 'cancelled') throw error
      throw this.provisionError(
        input,
        refusalId,
        'SANDBOX_PROVISION_FAILED',
        failure.publicMessage,
        10_000,
        failure.code,
        completion.controlVersion ?? claim.controlVersion
      )
    } finally {
      this.owned.delete(claim.attempt.attemptId)
      this.stopHeartbeatWhenIdle()
    }
  }

  private async observe<T>(
    input: CoordinatorRunInput<T>,
    attempt: OwnedAttempt,
    refusalId: string,
    controlVersion?: number
  ): Promise<T> {
    const sleep = this.options.sleep ?? defaultProvisionSleep
    while (!this.controller.signal.aborted) {
      const observed = await this.options.store.observe(attempt)
      if (!observed)
        throw this.provisionError(
          input,
          refusalId,
          'SANDBOX_PROVISION_BUSY',
          'Sandbox provisioning result expired.',
          5_000,
          undefined,
          controlVersion
        )
      if (observed.status === 'succeeded' && observed.podName)
        return input.attach(observed.podName, this.controller.signal)
      if (observed.status === 'failed' || observed.status === 'cancelled')
        throw this.provisionError(
          input,
          refusalId,
          'SANDBOX_PROVISION_FAILED',
          // Distinct from the classifier's `unknown` fallback, which uses the bare
          // "Sandbox provisioning failed." Both used to emit byte-identical text, so
          // `executions.error` could not tell an operator whether this process failed
          // to provision or merely observed another owner's failed attempt — and the
          // known `failureCode` was dropped from the only string anyone reads.
          observedFailureMessage(observed.status, observed.failureCode),
          10_000,
          observed.failureCode,
          controlVersion
        )
      await sleep(1_000, this.controller.signal)
    }
    throw this.controller.signal.reason ?? abortError()
  }

  private waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(signal.reason ?? abortError())
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? abortError())
      signal.addEventListener('abort', abort, { once: true })
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => void this.heartbeatOwned(), 10_000)
    this.heartbeatTimer.unref?.()
  }

  private async heartbeatOwned(): Promise<void> {
    await Promise.all(
      [...this.owned.values()].map(async (attempt) => {
        try {
          if (!(await this.options.store.heartbeat(attempt))) this.counters.ownershipLosses++
        } catch {
          this.counters.ownershipLosses++
        }
      })
    )
  }

  private stopHeartbeatWhenIdle(): void {
    if (this.owned.size || !this.heartbeatTimer) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  async assertInspectionAllowed(scope: string): Promise<void> {
    const cached = this.openCache.get(scope)
    if (cached && cached.until > Date.now()) {
      throw new SandboxProvisionError(
        'SANDBOX_PROVISION_UNAVAILABLE',
        'Sandbox scheduling is temporarily unavailable.',
        cached.until - Date.now()
      )
    }
    const shared = await this.options.store.diagnostics(scope)
    if (shared.state === 'open' && shared.retryAfterMs && shared.retryAfterMs > 0) {
      this.cacheOpen(scope, shared.retryAfterMs, shared.reasonCode, shared.version)
      this.counters.openRejects++
      throw new SandboxProvisionError(
        'SANDBOX_PROVISION_UNAVAILABLE',
        'Sandbox scheduling is temporarily unavailable.',
        shared.retryAfterMs
      )
    }
  }

  async getDiagnostics(scope: string) {
    const shared = await this.options.store.diagnostics(scope)
    return {
      ...shared,
      maxInFlight: this.options.config.maxConcurrent,
      ...this.getLocalDiagnostics(),
      counters: { ...this.counters },
    }
  }

  private recordTransition(scope: string, transition: ProvisionTransition): void {
    if (transition.to === 'open') {
      this.counters.opens++
      this.cacheOpen(
        scope,
        transition.retryAfterMs ?? this.options.config.cooldownMs,
        transition.reasonCode,
        transition.version
      )
    } else if (transition.to === 'half_open') {
      this.counters.halfOpens++
    } else if (transition.to === 'closed') {
      this.counters.closes++
      this.openCache.delete(scope)
    }
    this.options.onTransition?.(transition)
  }

  private cacheOpen(scope: string, retryAfterMs: number, reasonCode?: string, circuitVersion?: number): void {
    if (!this.openCache.has(scope) && this.openCache.size >= 8)
      this.openCache.delete(this.openCache.keys().next().value!)
    this.openCache.set(scope, { until: Date.now() + retryAfterMs, reasonCode, circuitVersion })
  }

  private rejectFromOpenCache(
    input: Pick<CoordinatorRunInput<unknown>, 'scope' | 'sandboxKey'>,
    refusalId: string
  ): void {
    const cached = this.openCache.get(input.scope)
    if (!cached) return
    const retryAfterMs = cached.until - Date.now()
    if (retryAfterMs <= 0) {
      this.openCache.delete(input.scope)
      return
    }
    this.counters.openRejects++
    throw this.provisionError(
      input,
      refusalId,
      'SANDBOX_PROVISION_UNAVAILABLE',
      'Sandbox scheduling is temporarily unavailable.',
      retryAfterMs,
      cached.reasonCode as import('./provision-failure').ProvisionFailureCode | undefined,
      cached.circuitVersion
    )
  }

  private provisionError(
    input: Pick<CoordinatorRunInput<unknown>, 'scope' | 'sandboxKey'>,
    refusalId: string,
    code: ConstructorParameters<typeof SandboxProvisionError>[0],
    message: string,
    retryAfterMs?: number,
    reasonCode?: import('./provision-failure').ProvisionFailureCode,
    circuitVersion?: number
  ): SandboxProvisionError {
    return new SandboxProvisionError(code, message, retryAfterMs, {
      scope: input.scope,
      sandboxKey: input.sandboxKey,
      reasonCode,
      circuitVersion,
      refusalId,
    })
  }

  getLocalDiagnostics() {
    return {
      localOperations: this.operations.size,
      localWaiters: [...this.operations.values()].reduce((sum, entry) => sum + entry.waiters, 0),
      ownedAttempts: this.owned.size,
      heartbeatActive: Boolean(this.heartbeatTimer),
      openCacheEntries: this.openCache.size,
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.controller.abort(abortError())
    await this.options.store.cancelOwned(this.options.ownerId).catch(() => {})
    const settling = Promise.allSettled([...this.operations.values()].map((entry) => entry.promise))
    const sleep = this.options.sleep ?? defaultProvisionSleep
    const timeoutController = new AbortController()
    const timeout = sleep(5_000, timeoutController.signal)
    timeout.catch(() => {})
    try {
      await Promise.race([settling, timeout])
    } finally {
      timeoutController.abort(abortError())
    }
    this.operations.clear()
    this.openCache.clear()
    this.owned.clear()
    this.stopHeartbeatWhenIdle()
  }
}
