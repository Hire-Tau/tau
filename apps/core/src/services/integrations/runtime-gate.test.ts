import { describe, expect, test } from 'bun:test'
import { buildAgentProjectionTargets, IntegrationRuntimeGate, withLazyProjectionManager } from './runtime-gate'
import { IntegrationProjectionReconciler } from './projection/reconciler'
import type { AssignedIntegrationConnectionRecord } from './connection-repository'

const now = new Date('2026-08-14T00:00:00Z')
const connection: AssignedIntegrationConnectionRecord = {
  id: 'connection',
  squadId: 'squad',
  providerKey: 'bigbrain',
  adapterVersion: 1,
  clientAuthority: 'local',
  authorizationFlowId: null,
  displayName: 'Brain',
  configuration: { version: 1 },
  credentialRef: 'private-ref',
  materialRevision: 'revision',
  validatedRevision: 'revision',
  enabled: true,
  authState: 'authenticated',
  healthState: 'healthy',
  grantedScopes: ['vault:read'],
  validatedAt: now,
  validationExpiresAt: new Date(now.getTime() + 60_000),
  lastErrorCode: null,
}

function setup(
  candidate: AssignedIntegrationConnectionRecord | null = connection,
  currentAuthority: () => 'local' | 'platform_broker' | undefined = () => 'local'
) {
  let assigned = candidate
  const gate = new IntegrationRuntimeGate({
    currentAuthority,
    repository: { getAssigned: async () => assigned },
    now: () => now,
    supportedAdapterVersion: () => 1,
    supportedConfigVersion: () => 1,
  })
  const input: Parameters<IntegrationRuntimeGate['check']>[0] = {
    agent: {
      id: 'agent',
      squadId: 'squad',
      integrationCapabilities: { version: 1 as const, allow: { bigbrain: ['agent_tools' as const] } },
    },
    squadId: 'squad',
    provider: 'bigbrain',
    capability: 'agent_tools' as const,
    requiredScope: 'vault:read',
  }
  return {
    gate,
    input,
    setAssigned: (value: AssignedIntegrationConnectionRecord | null) => {
      assigned = value
    },
  }
}

test('production projection builders defer manager resolution and fence the correct agent generation', async () => {
  const manager = { attachExistingSandbox: async () => true }
  let managerResolutions = 0
  const dependencies = { marker: 'production-composition' }
  const lazy = withLazyProjectionManager(dependencies, () => {
    managerResolutions += 1
    return manager
  })
  expect(lazy as object).toBe(dependencies)
  expect(managerResolutions).toBe(0)
  expect(lazy.manager).toBe(manager)
  expect(managerResolutions).toBe(1)

  const targets = await buildAgentProjectionTargets({
    agents: [{ id: 'agent-1', machineId: 'machine-1', getSandboxId: async () => 'agent_sandbox-1' }],
    resolveLifecycleGeneration: async () => 'generation-7',
    optionsForAgent: (agent, sandboxId) => ({
      squadId: 'squad-1',
      workspacePath: '/workspace/squad-1',
      machineId: agent.machineId ?? undefined,
      privateVolumePath: `/private/${sandboxId}`,
      k8s: { sandboxType: 'agent', alwaysOn: false, privateStorageKey: sandboxId },
    }),
  })
  expect(targets).toEqual([
    expect.objectContaining({
      sandboxId: 'agent_sandbox-1',
      lifecycleFence: { agentId: 'agent-1', generation: 'generation-7', compareGeneration: true },
      options: expect.objectContaining({ lifecycleGeneration: 'generation-7', machineId: 'machine-1' }),
    }),
  ])

  const cleanup: string[] = []
  let lifecycleChecks = 0
  const reconciler = new IntegrationProjectionReconciler({
    connections: { get: async () => null, getAssigned: async () => null },
    regenerateEnv: async () => {},
    manager: manager as never,
    targets: async () => targets,
    targetLifecycleIsCurrent: async () => ++lifecycleChecks === 1,
    cleanupLostTarget: async (_manager, sandboxId) => void cleanup.push(sandboxId),
    refreshAttached: async () => {},
    reconcileToolchain: async () => {},
    desiredFingerprint: async () => 'fingerprint',
  })
  await expect(
    reconciler.reconcile({
      squadId: 'squad-1',
      providerKey: 'notion',
      generation: 1n,
      status: 'installing',
      desiredFingerprint: null,
      appliedFingerprint: null,
      desiredCredentialRevision: null,
      appliedCredentialRevision: null,
      attempts: 1,
      nextAttemptAt: now,
      leaseToken: 'lease',
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      lastErrorCode: null,
    })
  ).rejects.toMatchObject({ code: 'agent_lifecycle_changed' })
  expect(cleanup).toEqual(['agent_sandbox-1'])
})

describe('IntegrationRuntimeGate', () => {
  test('allows only the assigned fresh healthy scoped connection', async () => {
    const { gate, input } = setup()
    expect(await gate.check(input)).toEqual({ allowed: true, connection })
  })

  test('managed deployment authority does not deny manual Bigbrain connections', async () => {
    const { gate, input } = setup(connection, () => undefined)
    expect(await gate.check(input)).toMatchObject({ allowed: true })
  })

  test('historical client authority is rejected before runtime credential use', async () => {
    const { gate, input } = setup({ ...connection, clientAuthority: 'platform_broker' })
    expect(await gate.check(input)).toEqual({ allowed: false, code: 'authority_mismatch' })
  })

  test('an enabled unassigned pool connection is unavailable', async () => {
    const { gate, input } = setup(null)
    expect(await gate.check(input)).toEqual({ allowed: false, code: 'connection_unavailable' })
  })

  test.each([
    ['wrong squad', { squadId: 'other' }, 'agent_scope_mismatch'],
    ['disabled assignment', { enabled: false }, 'connection_disabled'],
    ['invalid auth', { authState: 'invalid' }, 'authentication_invalid'],
    ['unhealthy', { healthState: 'unreachable' }, 'health_uncertain'],
    ['stale', { validationExpiresAt: now }, 'validation_stale'],
    ['changed revision', { validatedRevision: 'old' }, 'revision_mismatch'],
    ['missing scope', { grantedScopes: [] }, 'scope_missing'],
    ['wrong adapter', { adapterVersion: 2 }, 'unsupported_version'],
    ['wrong config', { configuration: { version: 2 } }, 'unsupported_version'],
  ] as const)('denies %s without provider I/O', async (_name, change, code) => {
    const { gate, input } = setup({ ...connection, ...change } as AssignedIntegrationConnectionRecord)
    if ('squadId' in change) input.agent.squadId = change.squadId
    expect(await gate.check(input)).toEqual({ allowed: false, code })
  })

  test('denies absent capability policy before assignment lookup matters', async () => {
    const { gate, input, setAssigned } = setup()
    input.agent.integrationCapabilities = null
    setAssigned(null)
    expect(await gate.check(input)).toEqual({ allowed: false, code: 'capability_not_allowed' })
  })
})
