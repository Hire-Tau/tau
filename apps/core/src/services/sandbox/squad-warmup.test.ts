import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { Squad } from '../../entities/Squad'
import { ensureSquadSandbox } from './ensure'
import { warmupActiveSquadSandboxes } from './squad-warmup'
import type { ShouldKeepSquadWarmDeps } from './keep-warm'

type EnsureFn = typeof ensureSquadSandbox

// Keep the deploy / work-stream signals off the DB in these unit tests; the
// agent-activity signal still runs through the real predicate over the fake
// getActiveAgents below.
const noExtraSignals: ShouldKeepSquadWarmDeps = {
  hasActiveLocalDeployments: async () => false,
  hasRecentWorkStreamActivity: async () => false,
}

type TestSquad = Pick<Squad, 'id' | 'getActiveAgents' | 'isSandboxAlwaysOn'>

interface SquadOptions {
  alwaysOn?: boolean
  /** lastMessageAt values for the squad's active top-level agents. */
  agentLastMessageAt?: Array<Date | null>
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000)
}

function squad(id: string, opts: SquadOptions = {}): TestSquad {
  const lastMessageAts = opts.agentLastMessageAt ?? []
  return {
    id,
    isSandboxAlwaysOn: opts.alwaysOn ?? false,
    getActiveAgents: async () =>
      lastMessageAts.map((lastMessageAt, index) => ({ id: `${id}-agent-${index}`, lastMessageAt })) as any,
  }
}

function logger() {
  return { info: () => {}, warn: () => {} }
}

describe('warmupActiveSquadSandboxes', () => {
  // `Squad.list` is a static method on the class object, so spying on it is a
  // plain property mutation — reliable across module load order. Track the spy
  // so we only restore what we actually created.
  let listSpy: ReturnType<typeof spyOn> | undefined

  afterEach(() => {
    listSpy?.mockRestore()
    listSpy = undefined
  })

  function mockSquadList(squads: TestSquad[]): TestSquad[] {
    listSpy = spyOn(Squad, 'list').mockResolvedValue(squads as Squad[])
    return squads
  }

  test('does not ensure any sandbox when there are no active squads', async () => {
    mockSquadList([])
    const ensure = mock<EnsureFn>(async () => '' as any)

    await warmupActiveSquadSandboxes(logger(), { ensure, keepWarmDeps: noExtraSignals })

    expect(ensure).toHaveBeenCalledTimes(0)
  })

  // Perf: shares the vm lifecycle tick's single active-squad fetch with the
  // spec reconcile instead of running the identical query again.
  test('uses squads passed in by the caller without touching Squad.list', async () => {
    const listSpy2 = spyOn(Squad, 'list')
    try {
      const squads = [squad('always-on', { alwaysOn: true })]
      const ensure = mock<EnsureFn>(async () => '' as any)

      await warmupActiveSquadSandboxes(logger(), {
        ensure,
        keepWarmDeps: noExtraSignals,
        squads: squads as Squad[],
      })

      expect(ensure).toHaveBeenCalledTimes(1)
      expect(listSpy2).not.toHaveBeenCalled()
    } finally {
      listSpy2.mockRestore()
    }
  })

  test('warms always-on squads regardless of recent agent activity', async () => {
    const squads = mockSquadList([
      squad('always-on-idle', { alwaysOn: true, agentLastMessageAt: [minutesAgo(120)] }),
      squad('always-on-no-agents', { alwaysOn: true, agentLastMessageAt: [] }),
    ])
    const ensure = mock<EnsureFn>(async () => '' as any)

    await warmupActiveSquadSandboxes(logger(), { ensure, keepWarmDeps: noExtraSignals })

    expect(ensure).toHaveBeenCalledTimes(2)
    expect(ensure).toHaveBeenCalledWith(squads[0], { restartManagedLocalDeployments: false })
    expect(ensure).toHaveBeenCalledWith(squads[1], { restartManagedLocalDeployments: false })
  })

  test('warms squads with agent activity in the last 30 minutes', async () => {
    const squads = mockSquadList([squad('recent', { agentLastMessageAt: [minutesAgo(5)] })])
    const ensure = mock<EnsureFn>(async () => '' as any)

    await warmupActiveSquadSandboxes(logger(), { ensure, keepWarmDeps: noExtraSignals })

    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledWith(squads[0], { restartManagedLocalDeployments: false })
  })

  test('skips squads that are not always-on and have no recent agent activity', async () => {
    mockSquadList([
      squad('stale', { agentLastMessageAt: [minutesAgo(45)] }),
      squad('never-messaged', { agentLastMessageAt: [null] }),
      squad('no-agents', { agentLastMessageAt: [] }),
    ])
    const ensure = mock<EnsureFn>(async () => '' as any)

    await warmupActiveSquadSandboxes(logger(), { ensure, keepWarmDeps: noExtraSignals })

    expect(ensure).toHaveBeenCalledTimes(0)
  })

  test('warms a stale squad kept warm by an active local deployment (deploy signal)', async () => {
    const squads = mockSquadList([squad('deployed', { agentLastMessageAt: [minutesAgo(120)] })])
    const ensure = mock<EnsureFn>(async () => '' as any)

    await warmupActiveSquadSandboxes(logger(), {
      ensure,
      keepWarmDeps: { hasActiveLocalDeployments: async () => true, hasRecentWorkStreamActivity: async () => false },
    })

    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledWith(squads[0], { restartManagedLocalDeployments: false })
  })

  test('warms a squad when any of its agents is recently active', async () => {
    const squads = mockSquadList([squad('mixed', { agentLastMessageAt: [minutesAgo(120), minutesAgo(2)] })])
    const ensure = mock<EnsureFn>(async () => '' as any)

    await warmupActiveSquadSandboxes(logger(), { ensure, keepWarmDeps: noExtraSignals })

    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledWith(squads[0], { restartManagedLocalDeployments: false })
  })

  test('continues warming other squads when one warmup fails', async () => {
    mockSquadList([
      squad('bad', { agentLastMessageAt: [minutesAgo(1)] }),
      squad('good', { agentLastMessageAt: [minutesAgo(1)] }),
    ])
    const ensure = mock<EnsureFn>(async (candidate) => {
      const id = typeof candidate === 'string' ? candidate : candidate.id
      if (id === 'bad') throw new Error('boom')
      return '' as any
    })

    await warmupActiveSquadSandboxes(logger(), { ensure, keepWarmDeps: noExtraSignals })

    expect(ensure).toHaveBeenCalledTimes(2)
  })

  test('limits concurrent sandbox warmups', async () => {
    mockSquadList(Array.from({ length: 8 }, (_, index) => squad(`squad-${index}`, { alwaysOn: true })))
    let inFlight = 0
    let maxInFlight = 0
    const ensure = mock<EnsureFn>(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight--
      return '' as any
    })

    await warmupActiveSquadSandboxes(logger(), { ensure, keepWarmDeps: noExtraSignals })

    expect(maxInFlight).toBeLessThanOrEqual(3)
  })
})

// Socket activation (spec D2): the lifecycle tick resolves each box's liveness
// from one `ss -ltnH` per machine; forwarding that hint is what stops this sweep
// from HTTP-probing — and so waking — an idle socket-activated box.
describe('box liveness hint', () => {
  test('is resolved per squad sandboxId and forwarded to ensure', async () => {
    const seen: Array<string | undefined> = []
    const ensure = (async (_squad: unknown, options: { boxLiveness?: string } = {}) => {
      seen.push(options.boxLiveness)
      return 'sb'
    }) as unknown as EnsureFn
    const asked: string[] = []
    await warmupActiveSquadSandboxes(logger(), {
      ensure,
      keepWarmDeps: noExtraSignals,
      squads: [squad('s1', { alwaysOn: true })] as unknown as Squad[],
      resolveBoxLiveness: (sandboxId) => {
        asked.push(sandboxId)
        return 'listening'
      },
    })
    expect(asked).toEqual([Squad.getSandboxId('s1')])
    expect(seen).toEqual(['listening'])
  })
})
