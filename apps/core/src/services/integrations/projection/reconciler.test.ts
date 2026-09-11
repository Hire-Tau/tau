import { expect, test } from 'bun:test'
import { IntegrationProjectionReconciler } from './reconciler'

test('reconciles every reachable deduplicated squad/member box before reporting applied state', async () => {
  const attached: string[] = []
  const reconciled: string[] = []
  const reconciler = new IntegrationProjectionReconciler({
    connections: { get: async () => null, getAssigned: async () => null },
    regenerateEnv: async () => undefined,
    manager: {
      attachExistingSandbox: async (sandboxId: string) => {
        attached.push(sandboxId)
        return sandboxId !== 'agent_cold'
      },
    } as any,
    targets: async () => [
      { sandboxId: 'squad_1', options: { workspacePath: '/workspace', squadId: '1' } },
      { sandboxId: 'agent_1', options: { workspacePath: '/workspace', squadId: '1' } },
      { sandboxId: 'agent_1', options: { workspacePath: '/workspace', squadId: '1' } },
      { sandboxId: 'agent_cold', options: { workspacePath: '/workspace', squadId: '1' } },
    ],
    reconcileToolchain: async (_manager, sandboxId) => void reconciled.push(sandboxId),
    desiredFingerprint: async () => 'a'.repeat(64),
  })

  await expect(reconciler.reconcile({ squadId: '1', providerKey: 'notion' } as any)).resolves.toEqual({
    fingerprint: 'a'.repeat(64),
    credentialRevision: null,
  })
  expect(attached).toEqual(['squad_1', 'agent_1', 'agent_cold'])
  expect(reconciled).toEqual(['squad_1', 'agent_1'])
})

test('rejects a stale agent snapshot before any projection effect', async () => {
  const attached: string[] = []
  const reconciler = new IntegrationProjectionReconciler({
    connections: { get: async () => null, getAssigned: async () => null },
    regenerateEnv: async () => undefined,
    manager: {
      attachExistingSandbox: async (sandboxId: string) => {
        attached.push(sandboxId)
        return true
      },
    } as any,
    targets: async () => [
      {
        sandboxId: 'agent_1',
        options: { workspacePath: '/workspace', lifecycleGeneration: 'generation-a' },
        lifecycleFence: { agentId: '1', generation: 'generation-a', compareGeneration: true },
      },
    ],
    targetLifecycleIsCurrent: async () => false,
    desiredFingerprint: async () => 'a'.repeat(64),
  })

  await expect(reconciler.reconcile({ squadId: '1', providerKey: 'notion' } as any)).rejects.toMatchObject({
    code: 'agent_lifecycle_changed',
  })
  expect(attached).toEqual([])
})

test('post-effect cleanup requests only stale A and preserves a concurrently woken B', async () => {
  let lifecycleChecks = 0
  let physicalGeneration = 'generation-a'
  const cleanupRequests: Array<string | null | undefined> = []
  const reconciler = new IntegrationProjectionReconciler({
    connections: { get: async () => null, getAssigned: async () => null },
    regenerateEnv: async () => undefined,
    manager: { attachExistingSandbox: async () => true } as any,
    targets: async () => [
      {
        sandboxId: 'agent_1',
        options: { workspacePath: '/workspace', lifecycleGeneration: 'generation-a' },
        lifecycleFence: { agentId: '1', generation: 'generation-a', compareGeneration: true },
      },
    ],
    targetLifecycleIsCurrent: async () => ++lifecycleChecks === 1,
    reconcileToolchain: async () => {
      physicalGeneration = 'generation-b'
    },
    cleanupLostTarget: async (_manager, _sandboxId, fence) => {
      cleanupRequests.push(fence.generation)
      if (physicalGeneration === fence.generation) physicalGeneration = 'stopped'
    },
    desiredFingerprint: async () => 'a'.repeat(64),
  })

  await expect(reconciler.reconcile({ squadId: '1', providerKey: 'notion' } as any)).rejects.toMatchObject({
    code: 'agent_lifecycle_changed',
  })
  expect(cleanupRequests).toEqual(['generation-a'])
  expect(physicalGeneration).toBe('generation-b')
})

test('an attach failure still post-checks and cleans only stale A after a wake to B', async () => {
  let lifecycleChecks = 0
  let physicalGeneration = 'generation-a'
  const cleanupRequests: Array<string | null | undefined> = []
  const reconciler = new IntegrationProjectionReconciler({
    connections: { get: async () => null, getAssigned: async () => null },
    regenerateEnv: async () => undefined,
    manager: {
      attachExistingSandbox: async () => {
        // Model Docker publishing A locally before its executor attachment fails.
        physicalGeneration = 'generation-a'
        // Concurrent dormancy/wake has already made B authoritative elsewhere.
        physicalGeneration = 'generation-b'
        throw new Error('executor attachment failed')
      },
    } as any,
    targets: async () => [
      {
        sandboxId: 'agent_1',
        options: { workspacePath: '/workspace', lifecycleGeneration: 'generation-a' },
        lifecycleFence: { agentId: '1', generation: 'generation-a', compareGeneration: true },
      },
    ],
    targetLifecycleIsCurrent: async () => ++lifecycleChecks === 1,
    cleanupLostTarget: async (_manager, _sandboxId, fence) => {
      cleanupRequests.push(fence.generation)
      if (physicalGeneration === fence.generation) physicalGeneration = 'stopped'
    },
    desiredFingerprint: async () => 'a'.repeat(64),
  })

  await expect(reconciler.reconcile({ squadId: '1', providerKey: 'notion' } as any)).rejects.toMatchObject({
    code: 'agent_lifecycle_changed',
  })
  expect(lifecycleChecks).toBe(2)
  expect(cleanupRequests).toEqual(['generation-a'])
  expect(physicalGeneration).toBe('generation-b')
})

test('an attach failure with a current lifecycle remains an ordinary readiness failure', async () => {
  const cleanupRequests: string[] = []
  const reconciler = new IntegrationProjectionReconciler({
    connections: { get: async () => null, getAssigned: async () => null },
    regenerateEnv: async () => undefined,
    manager: {
      attachExistingSandbox: async () => {
        throw new Error('executor attachment failed')
      },
    } as any,
    targets: async () => [
      {
        sandboxId: 'agent_1',
        options: { workspacePath: '/workspace', lifecycleGeneration: 'generation-a' },
        lifecycleFence: { agentId: '1', generation: 'generation-a', compareGeneration: true },
      },
    ],
    targetLifecycleIsCurrent: async () => true,
    cleanupLostTarget: async (_manager, sandboxId) => void cleanupRequests.push(sandboxId),
    desiredFingerprint: async () => 'a'.repeat(64),
  })

  await expect(reconciler.reconcile({ squadId: '1', providerKey: 'notion' } as any)).rejects.toMatchObject({
    code: 'toolchain_readiness_failed',
  })
  expect(cleanupRequests).toEqual([])
})

test('a reachable box failure prevents a generation from being reported ready', async () => {
  const reconciler = new IntegrationProjectionReconciler({
    connections: { get: async () => null, getAssigned: async () => null },
    regenerateEnv: async () => undefined,
    manager: { attachExistingSandbox: async () => true } as any,
    targets: async () => [{ sandboxId: 'squad_1', options: { workspacePath: '/workspace', squadId: '1' } }],
    reconcileToolchain: async () => {
      throw new Error('readiness failed')
    },
    desiredFingerprint: async () => 'a'.repeat(64),
  })

  await expect(reconciler.reconcile({ squadId: '1', providerKey: 'notion' } as any)).rejects.toMatchObject({
    code: 'toolchain_readiness_failed',
  })
})

test('protected env write failures retain an actionable safe code', async () => {
  const reconciler = new IntegrationProjectionReconciler({
    connections: { get: async () => null, getAssigned: async () => null },
    regenerateEnv: async () => {
      throw new Error('raw filesystem details')
    },
  })
  await expect(reconciler.reconcile({ squadId: '1', providerKey: 'notion' } as any)).rejects.toMatchObject({
    code: 'protected_env_write_failed',
  })
})
