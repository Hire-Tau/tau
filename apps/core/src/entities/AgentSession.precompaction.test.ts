import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { AgentSession, buildPrecompactionDeps } from './AgentSession'
import {
  bindPrecompactionController,
  getPrecompactionController,
  __resetPrecompactionRegistryForTests,
} from '../services/agent/precompaction/registry'

beforeEach(() => __resetPrecompactionRegistryForTests())

describe('buildPrecompactionDeps', () => {
  it('maps pi session accessors into controller deps and resolves the margin default', () => {
    const piSession = {
      getContextUsage: () => ({ tokens: 5, contextWindow: 200_000, percent: 0 }),
      settingsManager: {
        getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
      },
      isCompacting: false,
      sessionManager: { getBranch: () => [] },
      model: { provider: 'anthropic', id: 'claude-sonnet-4-6', contextWindow: 200_000 },
    } as never

    const deps = buildPrecompactionDeps(piSession, null, null)

    expect(deps.marginTokens).toBe(24_576)
    expect(deps.inFlightMarginTokens).toBe(8192)
    expect(deps.getContextUsage()).toEqual({ tokens: 5, contextWindow: 200_000 })
    expect(deps.getCompactionSettings().reserveTokens).toBe(16_384)
    expect(deps.isCompacting()).toBe(false)
    expect(deps.getModelKey()).toBe('anthropic/claude-sonnet-4-6/200000')
  })

  it('honors explicit margins', () => {
    const piSession = { sessionManager: { getBranch: () => [] } } as never
    const deps = buildPrecompactionDeps(piSession, 30_000, 4096)
    expect(deps.marginTokens).toBe(30_000)
    expect(deps.inFlightMarginTokens).toBe(4096)
  })
})

describe('AgentSession pre-compaction lifecycle', () => {
  it('dispose clears the session reference but does NOT dispose the controller (registry owns the lifetime)', () => {
    const dispose = mock(() => {})
    const wrapper = new AgentSession({} as never)

    wrapper.attachPrecompaction({ dispose } as never)
    wrapper.dispose()

    // The registry owns the controller's lifetime; session dispose must NOT
    // call controller.dispose() so an in-flight background bake can survive.
    expect(dispose).toHaveBeenCalledTimes(0)
    expect(wrapper.precompaction).toBeUndefined()
  })
})

describe('AgentSession precompaction registry wiring', () => {
  const fakeDeps = {
    getContextUsage: () => undefined,
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 1, keepRecentTokens: 1 }),
    isCompacting: () => false,
    snapshot: () => ({ entries: [], latestCompactionEntryId: null }),
    getModelKey: () => 'm',
    bake: async () => null,
    marginTokens: 1,
    inFlightMarginTokens: 1,
  }

  it('a second bind for the same agent reuses the registry controller', () => {
    const first = bindPrecompactionController('agent-x', fakeDeps)
    const second = bindPrecompactionController('agent-x', fakeDeps)
    expect(second).toBe(first)
    expect(getPrecompactionController('agent-x')).toBe(first)
  })

  it('session dispose leaves the registry controller intact (registry owns the lifetime)', () => {
    const controller = bindPrecompactionController('agent-survives-dispose', fakeDeps)!
    const wrapper = new AgentSession({} as never)
    wrapper.attachPrecompaction(controller)
    wrapper.dispose()
    expect(wrapper.precompaction).toBeUndefined()
    const stillThere = getPrecompactionController('agent-survives-dispose')
    expect(stillThere).toBe(controller)
    expect(stillThere?.isDisposed()).toBe(false)
  })
})
