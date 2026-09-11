import { describe, expect, test } from 'bun:test'
import {
  anyAgentRecentlyActive,
  collectWorkStreamAgentIds,
  hasRecentWorkStreamActivityForAgent,
  hasRecentWorkStreamActivityForSandbox,
} from './work-stream-activity'
import { collectWorkStreamAgentIds as canonicalCollectWorkStreamAgentIds } from '../work-streams/agent-ids'

const minsAgo = (m: number) => Date.now() - m * 60 * 1000
const agent = (id: string, lastMessageAt: Date | null, terminatedAt: Date | null = null) =>
  ({ id, lastMessageAt, terminatedAt, status: terminatedAt ? 'terminated' : 'idle' }) as any

describe('collectWorkStreamAgentIds', () => {
  test('re-exports the canonical work-stream helper', () => {
    // Mutation: restoring a sandbox-local implementation must break reference identity.
    expect(collectWorkStreamAgentIds).toBe(canonicalCollectWorkStreamAgentIds)
  })

  test('dedupes assignee and agentIds, drops nulls', () => {
    expect(collectWorkStreamAgentIds({ assigneeAgentId: 'a', agentIds: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(collectWorkStreamAgentIds({ assigneeAgentId: null, agentIds: null })).toEqual([])
  })
})

describe('anyAgentRecentlyActive', () => {
  const cutoff = minsAgo(30)
  test('true when a member messaged within the window', async () => {
    const loadAgent = async (id: string) => agent(id, new Date(minsAgo(5)))
    expect(await anyAgentRecentlyActive(['a'], cutoff, loadAgent)).toBe(true)
  })
  test('false when all members are stale', async () => {
    const loadAgent = async (id: string) => agent(id, new Date(minsAgo(45)))
    expect(await anyAgentRecentlyActive(['a'], cutoff, loadAgent)).toBe(false)
  })
  test('ignores terminated agents', async () => {
    const loadAgent = async (id: string) => agent(id, new Date(minsAgo(1)), new Date())
    expect(await anyAgentRecentlyActive(['a'], cutoff, loadAgent)).toBe(false)
  })

  // Perf: with no per-id loader injected the predicate must issue ONE set-based
  // query for the whole membership, not one `Agent.find` per member (each of
  // which also eager-loads the agent's squad + type). This is the hot path of
  // the 60s vm-sandbox-lifecycle tick.
  test('batches into a single query over all ids when no per-id loader is given', async () => {
    const calls: string[][] = []
    const loadAgents = async (ids: string[]) => {
      calls.push(ids)
      return ids.map((id) => agent(id, new Date(minsAgo(45))))
    }
    expect(await anyAgentRecentlyActive(['a', 'b', 'c'], cutoff, undefined, loadAgents)).toBe(false)
    expect(calls).toEqual([['a', 'b', 'c']])
  })

  test('batch path keeps the exact boolean semantics (recent / stale / terminated / missing)', async () => {
    const loadAgents = async () => [
      agent('stale', new Date(minsAgo(45))),
      agent('terminated', new Date(minsAgo(1)), new Date()),
      agent('recent', new Date(minsAgo(5))),
    ]
    expect(await anyAgentRecentlyActive(['stale', 'terminated', 'recent', 'gone'], cutoff, undefined, loadAgents)).toBe(
      true
    )

    const withoutRecent = async () => [agent('stale', new Date(minsAgo(45))), agent('null', null)]
    expect(await anyAgentRecentlyActive(['stale', 'null', 'gone'], cutoff, undefined, withoutRecent)).toBe(false)
  })

  test('does not query at all for an empty membership', async () => {
    let called = 0
    const loadAgents = async () => {
      called++
      return []
    }
    expect(await anyAgentRecentlyActive([], cutoff, undefined, loadAgents)).toBe(false)
    expect(called).toBe(0)
  })
})

describe('hasRecentWorkStreamActivityForAgent', () => {
  test('true when a teammate on a shared stream is active even if the agent is quiet', async () => {
    const listStreams = async () => [{ assigneeAgentId: null, agentIds: ['self', 'mate'] }] as any
    const loadAgent = async (id: string) =>
      id === 'mate' ? agent(id, new Date(minsAgo(2))) : agent(id, new Date(minsAgo(90)))
    expect(await hasRecentWorkStreamActivityForAgent('self', minsAgo(30), { listStreams, loadAgent })).toBe(true)
  })
  test('false when no stream member is recently active', async () => {
    const listStreams = async () => [{ assigneeAgentId: null, agentIds: ['self', 'mate'] }] as any
    const loadAgent = async (id: string) => agent(id, new Date(minsAgo(90)))
    expect(await hasRecentWorkStreamActivityForAgent('self', minsAgo(30), { listStreams, loadAgent })).toBe(false)
  })
  test('false when the owner is terminated even with active teammates (dead pods must be reaped)', async () => {
    const listStreams = async () => [{ assigneeAgentId: null, agentIds: ['self', 'mate'] }] as any
    const loadAgent = async (id: string) =>
      id === 'self' ? agent(id, new Date(minsAgo(90)), new Date()) : agent(id, new Date(minsAgo(2)))
    expect(await hasRecentWorkStreamActivityForAgent('self', minsAgo(30), { listStreams, loadAgent })).toBe(false)
  })
  test('false when the owner no longer exists', async () => {
    const listStreams = async () => [{ assigneeAgentId: null, agentIds: ['self', 'mate'] }] as any
    const loadAgent = async (id: string) => (id === 'self' ? null : agent(id, new Date(minsAgo(2))))
    expect(await hasRecentWorkStreamActivityForAgent('self', minsAgo(30), { listStreams, loadAgent })).toBe(false)
  })

  // Perf: the owner lookup stays per-id (one row), but each stream's membership
  // must go through the batched loader, not a per-member Agent.find loop.
  test('uses the batched membership loader when only the owner loader is injected', async () => {
    const listStreams = async () => [{ assigneeAgentId: null, agentIds: ['self', 'mate'] }] as any
    const loadAgent = async (id: string) => agent(id, new Date(minsAgo(90)))
    const calls: string[][] = []
    const loadAgents = async (ids: string[]) => {
      calls.push(ids)
      return ids.map((id) => (id === 'mate' ? agent(id, new Date(minsAgo(2))) : agent(id, new Date(minsAgo(90)))))
    }
    expect(await hasRecentWorkStreamActivityForAgent('self', minsAgo(30), { loadAgent, listStreams, loadAgents })).toBe(
      true
    )
    expect(calls).toEqual([['self', 'mate']])
  })
})

describe('hasRecentWorkStreamActivityForSandbox', () => {
  test('returns false for non-agent sandboxes without querying', async () => {
    expect(await hasRecentWorkStreamActivityForSandbox('squad_abc')).toBe(false)
    expect(await hasRecentWorkStreamActivityForSandbox('system_manager_u1')).toBe(false)
  })
  test('delegates for agent_<id> sandboxes', async () => {
    const listStreams = async () => [{ assigneeAgentId: 'self', agentIds: [] }] as any
    const loadAgent = async (id: string) => agent(id, new Date(minsAgo(1)))
    expect(await hasRecentWorkStreamActivityForSandbox('agent_self', { listStreams, loadAgent })).toBe(true)
  })
})
