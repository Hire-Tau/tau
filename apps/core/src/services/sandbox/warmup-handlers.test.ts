import { describe, expect, mock, test } from 'bun:test'
import { warmAgentById, warmWorkStreamAgents } from './warmup-handlers'

const agent = (id: string, terminatedAt: Date | null = null) =>
  ({ id, terminatedAt, status: terminatedAt ? 'terminated' : 'idle' }) as any

describe('warmAgentById', () => {
  test('warms a live agent', async () => {
    const ensureAgent = mock(async () => 'ensured' as const)
    await warmAgentById('a1', { loadAgent: async () => agent('a1'), ensureAgent })
    expect(ensureAgent).toHaveBeenCalledTimes(1)
  })
  test('skips a terminated agent', async () => {
    const ensureAgent = mock(async () => 'ensured' as const)
    await warmAgentById('a1', { loadAgent: async () => agent('a1', new Date()), ensureAgent })
    expect(ensureAgent).not.toHaveBeenCalled()
  })
  test('swallows loader errors', async () => {
    const ensureAgent = mock(async () => 'ensured' as const)
    await warmAgentById('a1', {
      loadAgent: async () => {
        throw new Error('db down')
      },
      ensureAgent,
    })
    expect(ensureAgent).not.toHaveBeenCalled()
  })
})

describe('warmWorkStreamAgents', () => {
  test('warms all attached agents of a non-terminal stream', async () => {
    const ensureAgent = mock(async () => 'ensured' as const)
    await warmWorkStreamAgents('ws1', {
      loadStream: async () => ({ status: 'in_progress', assigneeAgentId: 'a', agentIds: ['b'] }) as any,
      loadAgent: async (id: string) => agent(id),
      ensureAgent,
    })
    expect(ensureAgent.mock.calls.map((c) => (c as any[])[0].id).sort()).toEqual(['a', 'b'])
  })
  test('does nothing for a terminal stream', async () => {
    const ensureAgent = mock(async () => 'ensured' as const)
    await warmWorkStreamAgents('ws1', {
      loadStream: async () => ({ status: 'done', assigneeAgentId: 'a', agentIds: ['b'] }) as any,
      loadAgent: async (id: string) => agent(id),
      ensureAgent,
    })
    expect(ensureAgent).not.toHaveBeenCalled()
  })
  test('does nothing for a queued (parked) stream — warming would defeat the sandbox gate', async () => {
    const ensureAgent = mock(async () => 'ensured' as const)
    await warmWorkStreamAgents('ws1', {
      loadStream: async () => ({ status: 'queued', assigneeAgentId: 'a', agentIds: ['b'] }) as any,
      loadAgent: async (id: string) => agent(id),
      ensureAgent,
    })
    expect(ensureAgent).not.toHaveBeenCalled()
  })
})
