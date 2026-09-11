import { describe, it, expect } from 'bun:test'
import { mapSandboxExecFailure, agentIdFromSandboxId, type SandboxOutageDeps } from './outage'
import type { RegisterWatchInput } from './recovery-watch'

function makeDeps(status: { status: string; reason?: string } | Error) {
  const registered: RegisterWatchInput[] = []
  const recoveries: string[] = []
  const deps: SandboxOutageDeps = {
    getLiveStatus: async () => {
      if (status instanceof Error) throw status
      return status as { status: never; reason?: string }
    },
    registerWatch: async (input) => {
      registered.push(input)
    },
    triggerRecovery: (sandboxId) => {
      recoveries.push(sandboxId)
    },
  }
  return { deps, registered, recoveries }
}

const original = new Error('fetch failed: ECONNREFUSED')

describe('agentIdFromSandboxId', () => {
  it('derives the agent id from an agent_ sandbox id', () => {
    expect(agentIdFromSandboxId('agent_abc123')).toBe('abc123')
  })

  it('returns null for squad and unknown sandbox ids', () => {
    expect(agentIdFromSandboxId('squad_s1')).toBeNull()
    expect(agentIdFromSandboxId('whatever')).toBeNull()
  })
})

describe('mapSandboxExecFailure', () => {
  it('returns the original error untouched when the pod is running (command/transport blip)', async () => {
    const { deps, registered, recoveries } = makeDeps({ status: 'running' })

    const mapped = await mapSandboxExecFailure({ sandboxId: 'agent_a1', agentId: 'a1', original }, deps)

    expect(mapped).toBe(original)
    expect(registered).toHaveLength(0)
    expect(recoveries).toHaveLength(0)
  })

  it('maps a dead private box to a structured outage error, registers a crash watch, and triggers recovery', async () => {
    const { deps, registered, recoveries } = makeDeps({ status: 'failed', reason: 'OOMKilled' })

    const mapped = await mapSandboxExecFailure({ sandboxId: 'agent_a1', agentId: 'a1', original }, deps)

    expect(mapped).not.toBe(original)
    expect(mapped.message).toContain('agent_a1')
    expect(mapped.message).toContain('private box')
    expect(mapped.message).toContain('currently unavailable')
    expect(mapped.message).toContain('OOMKilled')
    expect(mapped.message).toContain('notification')
    // Neutral wording — never blames the command
    expect(mapped.message.toLowerCase()).not.toContain('your command')
    expect(mapped.message.toLowerCase()).not.toContain('caused by')

    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ agentId: 'a1', sandboxIds: ['agent_a1'], crash: true, reason: 'OOMKilled' })
    expect(recoveries).toEqual(['agent_a1'])
  })

  it('names the squad box for squad_ sandbox ids', async () => {
    const { deps, registered } = makeDeps({ status: 'failed', reason: 'OOMKilled' })

    const mapped = await mapSandboxExecFailure({ sandboxId: 'squad_s1', agentId: 'a1', original }, deps)

    expect(mapped.message).toContain('shared squad box')
    expect(registered[0].agentId).toBe('a1')
  })

  it('treats a recreating box (starting/pending) as an outage without charging the crash budget', async () => {
    const { deps, registered } = makeDeps({ status: 'starting' })

    const mapped = await mapSandboxExecFailure({ sandboxId: 'agent_a1', agentId: 'a1', original }, deps)

    expect(mapped).not.toBe(original)
    expect(mapped.message).toContain('currently unavailable')
    expect(registered).toHaveLength(1)
    expect(registered[0].crash).toBeFalsy()
  })

  it('still returns a structured error without an agentId, but registers no watch and points at sandbox_status', async () => {
    const { deps, registered, recoveries } = makeDeps({ status: 'not_found' })

    const mapped = await mapSandboxExecFailure({ sandboxId: 'squad_s1', original }, deps)

    expect(mapped).not.toBe(original)
    expect(registered).toHaveLength(0)
    expect(recoveries).toEqual(['squad_s1'])
    expect(mapped.message).toContain('sandbox_status')
  })

  it('mentions browser commands in the outage message (browser tools now depend on the sandbox)', async () => {
    const { deps } = makeDeps({ status: 'failed', reason: 'OOMKilled' })

    const mapped = await mapSandboxExecFailure({ sandboxId: 'agent_a1', agentId: 'a1', original }, deps)

    expect(mapped.message).toContain('bash, file, and browser commands')
  })

  it('fails open (original error) when the live status check itself fails', async () => {
    const { deps, registered, recoveries } = makeDeps(new Error('cluster unreachable'))

    const mapped = await mapSandboxExecFailure({ sandboxId: 'agent_a1', agentId: 'a1', original }, deps)

    expect(mapped).toBe(original)
    expect(registered).toHaveLength(0)
    expect(recoveries).toHaveLength(0)
  })
})
