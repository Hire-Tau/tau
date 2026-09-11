import { expect, mock, test } from 'bun:test'
import { warmupWorkStreamAgentSandboxes } from './work-stream-warmup'

const minsAgo = (m: number) => new Date(Date.now() - m * 60 * 1000)
const log = { info: () => {}, warn: () => {} }
const agent = (id: string, lastMessageAt: Date | null) =>
  ({ id, lastMessageAt, status: 'idle', terminatedAt: null, parentAgentId: null }) as any

test('warms every member of a stream when one member is recently active', async () => {
  const listStreams = async () => [{ assigneeAgentId: null, agentIds: ['a', 'b'] }] as any
  const loadAgent = async (id: string) => (id === 'a' ? agent(id, minsAgo(2)) : agent(id, minsAgo(90)))
  const ensureAgent = mock(async () => 'ensured' as const)

  await warmupWorkStreamAgentSandboxes(log, { listStreams, loadAgent, ensureAgent })

  const warmed = ensureAgent.mock.calls.map((c) => (c as any[])[0].id).sort()
  expect(warmed).toEqual(['a', 'b'])
})

test('does not warm a stream with no recently active member', async () => {
  const listStreams = async () => [{ assigneeAgentId: null, agentIds: ['a', 'b'] }] as any
  const loadAgent = async (id: string) => agent(id, minsAgo(90))
  const ensureAgent = mock(async () => 'ensured' as const)

  await warmupWorkStreamAgentSandboxes(log, { listStreams, loadAgent, ensureAgent })

  expect(ensureAgent).not.toHaveBeenCalled()
})

test('dedupes an agent shared across two active streams', async () => {
  const listStreams = async () =>
    [
      { assigneeAgentId: null, agentIds: ['a', 'shared'] },
      { assigneeAgentId: null, agentIds: ['shared', 'c'] },
    ] as any
  const loadAgent = async (id: string) => agent(id, minsAgo(1))
  const ensureAgent = mock(async () => 'ensured' as const)

  await warmupWorkStreamAgentSandboxes(log, { listStreams, loadAgent, ensureAgent })

  const warmed = ensureAgent.mock.calls.map((c) => (c as any[])[0].id)
  expect(warmed.filter((id) => id === 'shared').length).toBe(1)
})

// Perf: the sweep used to resolve activity with one eager `Agent.find` per
// member PER STREAM. Every member of every stream must now be resolved by a
// single set-based activity query for the whole pass.
test('resolves the activity of every member of every stream with ONE batched query', async () => {
  const listStreams = async () =>
    [
      { assigneeAgentId: null, agentIds: ['a', 'shared'] },
      { assigneeAgentId: 'shared', agentIds: ['c'] },
    ] as any
  const calls: string[][] = []
  const loadAgentActivity = async (ids: string[]) => {
    calls.push([...ids].sort())
    return ids.map((id) => agent(id, minsAgo(1)))
  }
  const ensureAgent = mock(async () => 'ensured' as const)

  await warmupWorkStreamAgentSandboxes(log, {
    listStreams,
    loadAgentActivity,
    loadAgent: async (id: string) => agent(id, minsAgo(1)),
    ensureAgent,
  })

  expect(calls).toEqual([['a', 'c', 'shared']])
  expect(ensureAgent.mock.calls.map((c) => (c as any[])[0].id).sort()).toEqual(['a', 'c', 'shared'])
})

test('never issues an activity query when no stream has members', async () => {
  const listStreams = async () => [{ assigneeAgentId: null, agentIds: [] }] as any
  let called = 0
  const loadAgentActivity = async () => {
    called++
    return []
  }
  const ensureAgent = mock(async () => 'ensured' as const)

  await warmupWorkStreamAgentSandboxes(log, { listStreams, loadAgentActivity, ensureAgent })

  expect(called).toBe(0)
  expect(ensureAgent).not.toHaveBeenCalled()
})

test('a failing ensure does not abort the rest', async () => {
  const listStreams = async () => [{ assigneeAgentId: null, agentIds: ['a', 'b'] }] as any
  const loadAgent = async (id: string) => agent(id, minsAgo(1))
  const ensureAgent = mock(async (a: any) => {
    if (a.id === 'a') throw new Error('boom')
    return 'ensured' as const
  })

  await warmupWorkStreamAgentSandboxes(log, { listStreams, loadAgent, ensureAgent })

  expect(ensureAgent.mock.calls.length).toBe(2)
})

// Socket activation (spec D2): the tick learns each box's liveness from one
// `ss -ltnH` per machine and hands this sweep a resolver. Forwarding it is what
// stops every keep-warm ensure from HTTP-probing — and so WAKING — an idle box.
test('forwards the caller liveness resolver to each ensure', async () => {
  const listStreams = async () => [{ assigneeAgentId: null, agentIds: ['a'] }] as any
  const loadAgent = async (id: string) => agent(id, minsAgo(1))
  const ensureAgent = mock(async () => 'ensured' as const)
  const resolveBoxLiveness = () => 'listening' as const

  await warmupWorkStreamAgentSandboxes(log, { listStreams, loadAgent, ensureAgent, resolveBoxLiveness })

  expect((ensureAgent.mock.calls[0] as any[])[1]).toEqual({ resolveBoxLiveness })
})
