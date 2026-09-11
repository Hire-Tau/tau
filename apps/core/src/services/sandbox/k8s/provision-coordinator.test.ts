import { describe, expect, mock, test } from 'bun:test'
import { DEFAULT_PROVISION_CONFIG } from './provision-config'
import { SandboxProvisionError } from './provision-errors'
import { observedFailureMessage, ProvisionCoordinator } from './provision-coordinator'
import type { ClaimInput, OwnedAttempt, ProvisionStore } from './provision-store'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function fakeStore(): ProvisionStore & { claims: number; cancellations: number } {
  let attempt: OwnedAttempt | undefined
  return {
    claims: 0,
    cancellations: 0,
    async claim(input: ClaimInput) {
      this.claims++
      if (attempt) return { kind: 'join', attempt }
      attempt = {
        ...input,
        attemptId: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 30_000),
        probe: false,
      }
      return { kind: 'owner', attempt }
    },
    async heartbeat() {
      return true
    },
    async complete() {
      return { accepted: true }
    },
    async observe() {
      return { status: 'succeeded', podName: 'pod', resultSpecHash: 'spec' }
    },
    async cancelOwned() {
      this.cancellations++
    },
    async diagnostics() {
      return { state: 'closed', inFlight: 0 }
    },
  }
}

const input = (provision: (signal: AbortSignal) => Promise<string>, signal?: AbortSignal) => ({
  scope: 'scope',
  sandboxKey: 'box',
  operationKind: 'ensure' as const,
  desiredSpecHash: 'spec',
  signal,
  provision: async (operationSignal: AbortSignal) => ({
    podName: await provision(operationSignal),
    resultSpecHash: 'spec',
  }),
  attach: async (podName: string) => podName,
})

describe('ProvisionCoordinator', () => {
  test('shares one local promise and store claim', async () => {
    const store = fakeStore()
    const work = deferred<string>()
    const coordinator = new ProvisionCoordinator({ store, config: DEFAULT_PROVISION_CONFIG, ownerId: 'owner' })
    const calls = Array.from({ length: 10 }, () => coordinator.run(input(() => work.promise)))
    work.resolve('pod')
    expect(await Promise.all(calls)).toEqual(Array(10).fill('pod'))
    expect(store.claims).toBe(1)
    expect(coordinator.getLocalDiagnostics()).toMatchObject({ localOperations: 0, localWaiters: 0 })
  })

  test('rejects callers beyond the waiter bound without queuing', async () => {
    const store = fakeStore()
    const work = deferred<string>()
    const coordinator = new ProvisionCoordinator({
      store,
      config: { ...DEFAULT_PROVISION_CONFIG, maxWaiters: 2 },
      ownerId: 'owner',
    })
    const first = coordinator.run(input(() => work.promise))
    const second = coordinator.run(input(() => work.promise))
    await expect(coordinator.run(input(() => work.promise))).rejects.toMatchObject({ code: 'SANDBOX_PROVISION_BUSY' })
    work.resolve('pod')
    await Promise.all([first, second])
  })

  test('caller abort does not cancel shared owner while another waiter remains', async () => {
    const store = fakeStore()
    const work = deferred<string>()
    const coordinator = new ProvisionCoordinator({ store, config: DEFAULT_PROVISION_CONFIG, ownerId: 'owner' })
    const controller = new AbortController()
    const cancelled = coordinator.run(input(() => work.promise, controller.signal))
    const remaining = coordinator.run(input(() => work.promise))
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    work.resolve('pod')
    expect(await remaining).toBe('pod')
    expect(store.cancellations).toBe(0)
  })

  test('shutdown aborts owned work and clears local state', async () => {
    const store = fakeStore()
    const provision = mock(
      (signal: AbortSignal) =>
        new Promise<string>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
    )
    const coordinator = new ProvisionCoordinator({ store, config: DEFAULT_PROVISION_CONFIG, ownerId: 'owner' })
    const result = coordinator.run(input(provision))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await coordinator.shutdown()
    await expect(result).rejects.toBeDefined()
    expect(store.cancellations).toBe(1)
    expect(coordinator.getLocalDiagnostics()).toMatchObject({ localOperations: 0, localWaiters: 0 })
  })
})

describe('safe recovery context', () => {
  test('attaches scope, sandbox, version, reason, and a refusal id to an open refusal', async () => {
    const store = fakeStore()
    store.claim = async () => ({
      kind: 'open',
      retryAfterMs: 30_000,
      reasonCode: 'control_plane_unavailable',
      controlVersion: 7,
    })
    const coordinator = new ProvisionCoordinator({ store, config: DEFAULT_PROVISION_CONFIG, ownerId: 'owner' })

    await expect(coordinator.run(input(async () => 'pod'))).rejects.toMatchObject({
      provision: {
        scope: 'scope',
        sandboxKey: 'box',
        reasonCode: 'control_plane_unavailable',
        circuitVersion: 7,
        refusalId: expect.any(String),
      },
    })
  })

  test('preserves a joined owner failure classification', async () => {
    const store = fakeStore()
    const attempt: OwnedAttempt = {
      scope: 'scope',
      sandboxKey: 'box',
      operationKind: 'ensure',
      desiredSpecHash: 'spec',
      ownerId: 'other',
      attemptId: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 30_000),
      probe: false,
    }
    store.claim = async () => ({ kind: 'join', attempt, controlVersion: 9 })
    store.observe = async () => ({ status: 'failed', failureCode: 'storage_substrate' })
    const coordinator = new ProvisionCoordinator({ store, config: DEFAULT_PROVISION_CONFIG, ownerId: 'owner' })

    // Assert the EMITTED error string, not just the reasonCode: this is the
    // message that lands in `executions.error`, the only text an operator reads.
    // It must carry the known failureCode and be distinguishable from the
    // classifier's bare `Sandbox provisioning failed.` fallback — reverting the
    // call site to that literal (dropping observedFailureMessage) reds this.
    const error = await coordinator.run(input(async () => 'unused')).then(
      () => undefined,
      (e) => e as Error
    )
    expect(error?.message).toBe(observedFailureMessage('failed', 'storage_substrate'))
    expect(error?.message).toContain('storage_substrate')
    expect(error?.message).not.toBe('Sandbox provisioning failed.')
    expect(error).toMatchObject({ provision: { reasonCode: 'storage_substrate', circuitVersion: 9 } })
  })
})

describe('open cache and diagnostics', () => {
  test('bounds repeated open rejects to one store claim', async () => {
    const store = fakeStore()
    store.claim = async function () {
      this.claims++
      return {
        kind: 'open',
        retryAfterMs: 30_000,
        reasonCode: 'control_plane_unavailable',
        controlVersion: 12,
      } as const
    }
    const transitions: unknown[] = []
    const coordinator = new ProvisionCoordinator({
      store,
      config: DEFAULT_PROVISION_CONFIG,
      ownerId: 'owner',
      onTransition: (event) => transitions.push(event),
    })
    const first = await coordinator
      .run({ ...input(async () => 'pod'), sandboxKey: 'initial' })
      .catch((error: unknown) => error as SandboxProvisionError)
    const cached = await coordinator
      .run({ ...input(async () => 'pod'), sandboxKey: 'cached' })
      .catch((error: unknown) => error as SandboxProvisionError)
    const firstError = first as SandboxProvisionError
    const cachedError = cached as SandboxProvisionError
    expect(firstError.provision?.circuitVersion).toBe(12)
    expect(cachedError.provision?.circuitVersion).toBe(12)
    expect(cachedError.provision?.refusalId).not.toBe(firstError.provision?.refusalId)
    const calls = Array.from({ length: 999 }, (_, index) =>
      coordinator.run({ ...input(async () => 'pod'), sandboxKey: `box-${index}` })
    )
    const results = await Promise.allSettled(calls)
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(store.claims).toBe(1)
    expect(coordinator.getLocalDiagnostics().openCacheEntries).toBe(1)
    expect((await coordinator.getDiagnostics('scope')).counters.openRejects).toBe(1_001)
    expect(transitions).toEqual([])
  })

  test('inspection rejects from durable open state and then from cache', async () => {
    const store = fakeStore()
    let diagnosticsCalls = 0
    store.diagnostics = async () => {
      diagnosticsCalls++
      return { state: 'open', inFlight: 0, retryAfterMs: 30_000, reasonCode: 'control_plane_unavailable' }
    }
    const coordinator = new ProvisionCoordinator({ store, config: DEFAULT_PROVISION_CONFIG, ownerId: 'owner' })
    await expect(coordinator.assertInspectionAllowed('scope')).rejects.toMatchObject({
      code: 'SANDBOX_PROVISION_UNAVAILABLE',
    })
    await expect(coordinator.assertInspectionAllowed('scope')).rejects.toMatchObject({
      code: 'SANDBOX_PROVISION_UNAVAILABLE',
    })
    expect(diagnosticsCalls).toBe(1)
  })
})

describe('half-open transition accounting', () => {
  function probeStore() {
    const store = fakeStore()
    store.claim = async (claimInput) => ({
      kind: 'owner' as const,
      attempt: {
        ...claimInput,
        attemptId: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 30_000),
        probe: true,
      },
      transition: { from: 'open', to: 'half_open', version: 1, inFlight: 1 },
    })
    store.complete = async (completion) => ({
      accepted: true,
      transition:
        completion.kind === 'success'
          ? { from: 'half_open', to: 'closed', version: 2, inFlight: 0 }
          : {
              from: 'half_open',
              to: 'open',
              version: 2,
              reasonCode: completion.failureCode,
              retryAfterMs: DEFAULT_PROVISION_CONFIG.cooldownMs,
              inFlight: 0,
            },
    })
    return store
  }

  test('emits half-open success exactly once after accepted completion', async () => {
    const transitions: unknown[] = []
    const coordinator = new ProvisionCoordinator({
      store: probeStore(),
      config: DEFAULT_PROVISION_CONFIG,
      ownerId: 'owner',
      onTransition: (event) => transitions.push(event),
    })
    await coordinator.run(input(async () => 'pod'))
    expect(transitions).toEqual([
      { from: 'open', to: 'half_open', version: 1, inFlight: 1 },
      { from: 'half_open', to: 'closed', version: 2, inFlight: 0 },
    ])
  })

  test('emits and caches accepted qualifying probe failure exactly once', async () => {
    const transitions: unknown[] = []
    const coordinator = new ProvisionCoordinator({
      store: probeStore(),
      config: DEFAULT_PROVISION_CONFIG,
      ownerId: 'owner',
      onTransition: (event) => transitions.push(event),
    })
    await expect(
      coordinator.run(
        input(async () => {
          // A REAL unreachable control plane: Bun reports `code: 'ConnectionRefused'`,
          // never Node's `ECONNREFUSED`.
          await fetch('http://127.0.0.1:1')
          throw new Error('expected the connection to be refused')
        })
      )
    ).rejects.toMatchObject({ code: 'SANDBOX_PROVISION_FAILED' })
    expect(transitions).toEqual([
      { from: 'open', to: 'half_open', version: 1, inFlight: 1 },
      {
        from: 'half_open',
        to: 'open',
        version: 2,
        reasonCode: 'control_plane_unavailable',
        retryAfterMs: DEFAULT_PROVISION_CONFIG.cooldownMs,
        inFlight: 0,
      },
    ])
    expect(coordinator.getLocalDiagnostics().openCacheEntries).toBe(1)
  })

  test('does not infer a transition when probe completion is fenced', async () => {
    const store = probeStore()
    store.complete = async () => ({ accepted: false })
    const transitions: unknown[] = []
    const coordinator = new ProvisionCoordinator({
      store,
      config: DEFAULT_PROVISION_CONFIG,
      ownerId: 'owner',
      onTransition: (event) => transitions.push(event),
    })
    await expect(coordinator.run(input(async () => 'pod'))).rejects.toMatchObject({ code: 'SANDBOX_PROVISION_BUSY' })
    expect(transitions).toEqual([{ from: 'open', to: 'half_open', version: 1, inFlight: 1 }])
    expect(coordinator.getLocalDiagnostics().openCacheEntries).toBe(0)
  })
})

describe('bounded shutdown and heartbeat failures', () => {
  test('shutdown stays pending until the controllable five-second boundary', async () => {
    const store = fakeStore()
    let reachDeadline!: () => void
    const coordinator = new ProvisionCoordinator({
      store,
      config: DEFAULT_PROVISION_CONFIG,
      ownerId: 'owner',
      sleep: (_ms, signal) =>
        new Promise<void>((resolve, reject) => {
          reachDeadline = resolve
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    })
    const result = coordinator.run(input(async () => new Promise<string>(() => {})))
    result.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    let settled = false
    const shutdown = coordinator.shutdown().then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    expect(reachDeadline).toBeFunction()
    reachDeadline()
    await shutdown
    expect(settled).toBe(true)
    expect(store.cancellations).toBe(1)
    expect(coordinator.getLocalDiagnostics()).toMatchObject({
      localOperations: 0,
      localWaiters: 0,
      ownedAttempts: 0,
      heartbeatActive: false,
    })
  })

  test('early operation settlement cancels the retained shutdown deadline', async () => {
    const store = fakeStore()
    let deadlineCancelled = false
    const coordinator = new ProvisionCoordinator({
      store,
      config: DEFAULT_PROVISION_CONFIG,
      ownerId: 'owner',
      sleep: (_ms, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              deadlineCancelled = true
              reject(signal.reason)
            },
            { once: true }
          )
        }),
    })
    expect(await coordinator.run(input(async () => 'pod'))).toBe('pod')
    await coordinator.shutdown()
    expect(deadlineCancelled).toBe(true)
  })

  test('heartbeat rejection and lost ownership are handled without rejection', async () => {
    const store = fakeStore()
    const coordinator = new ProvisionCoordinator({ store, config: DEFAULT_PROVISION_CONFIG, ownerId: 'owner' })
    const attempt = {
      scope: 'scope',
      sandboxKey: 'box',
      operationKind: 'ensure' as const,
      desiredSpecHash: 'spec',
      ownerId: 'owner',
      attemptId: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 30_000),
      probe: false,
    }
    ;(coordinator as any).owned.set(attempt.attemptId, attempt)
    store.heartbeat = async () => {
      throw new Error('db down')
    }
    await (coordinator as any).heartbeatOwned()
    store.heartbeat = async () => false
    await (coordinator as any).heartbeatOwned()
    expect((await coordinator.getDiagnostics('scope')).counters.ownershipLosses).toBe(2)
  })
})
