import { describe, expect, test } from 'bun:test'
import { shouldKeepSquadWarm, type ShouldKeepSquadWarmDeps, type SquadForKeepWarm } from './keep-warm'
import { shouldParkBox, type IdleCandidate } from './vm/idle'

const NOW = 10_000_000
const IDLE_TIMEOUT_MS = 15 * 60 * 1000

function minutesAgo(minutes: number): Date {
  return new Date(NOW - minutes * 60 * 1000)
}

/** A squad whose (single) active agent last messaged `agentMsgMinutesAgo` ago. */
function makeSquad(opts: { alwaysOn?: boolean; agentMsgMinutesAgo?: number | null }): SquadForKeepWarm {
  const last = opts.agentMsgMinutesAgo == null ? null : minutesAgo(opts.agentMsgMinutesAgo)
  return {
    id: 's1',
    isSandboxAlwaysOn: opts.alwaysOn ?? false,
    getActiveAgents: async () => [{ id: 's1-agent', lastMessageAt: last }] as any,
  }
}

/** deploy / work-stream signals as injected booleans (the production seam). */
function signalDeps(deploy: boolean, workStream: boolean): ShouldKeepSquadWarmDeps {
  return {
    hasActiveLocalDeployments: async () => deploy,
    hasRecentWorkStreamActivity: async () => workStream,
  }
}

describe('shouldKeepSquadWarm — individual signals', () => {
  test('always-on squad is kept warm with no other signal', async () => {
    const kept = await shouldKeepSquadWarm(makeSquad({ alwaysOn: true }), NOW, signalDeps(false, false))
    expect(kept).toBe(true)
  })

  test('recent agent activity (within 30m, real predicate) keeps it warm', async () => {
    const kept = await shouldKeepSquadWarm(makeSquad({ agentMsgMinutesAgo: 10 }), NOW, signalDeps(false, false))
    expect(kept).toBe(true)
  })

  test('active local deployment keeps it warm without agent activity', async () => {
    const kept = await shouldKeepSquadWarm(makeSquad({ agentMsgMinutesAgo: 45 }), NOW, signalDeps(true, false))
    expect(kept).toBe(true)
  })

  test('recent work-stream activity keeps it warm without agent activity', async () => {
    const kept = await shouldKeepSquadWarm(makeSquad({ agentMsgMinutesAgo: 45 }), NOW, signalDeps(false, true))
    expect(kept).toBe(true)
  })

  test('no signal at all → not kept warm', async () => {
    const kept = await shouldKeepSquadWarm(makeSquad({ agentMsgMinutesAgo: 45 }), NOW, signalDeps(false, false))
    expect(kept).toBe(false)
  })

  test('stale agent message (older than 30m) does not keep it warm', async () => {
    const kept = await shouldKeepSquadWarm(makeSquad({ agentMsgMinutesAgo: 31 }), NOW, signalDeps(false, false))
    expect(kept).toBe(false)
  })
})

describe('warmup/reaper invariant — shared predicate cannot drift', () => {
  interface State {
    alwaysOn: boolean
    recentMsg: boolean
    deploy: boolean
    workStream: boolean
    idleAgeMin: number
  }

  // recentMsg is exercised through the REAL hasRecentAgentActivity: a "recent"
  // agent messaged 10m ago (inside the 30m window), a non-recent one 45m ago.
  function squadFor(state: State): SquadForKeepWarm {
    return makeSquad({ alwaysOn: state.alwaysOn, agentMsgMinutesAgo: state.recentMsg ? 10 : 45 })
  }

  // WARMUP side: its decision function IS shouldKeepSquadWarm.
  function warmupWouldEnsure(state: State): Promise<boolean> {
    return shouldKeepSquadWarm(squadFor(state), NOW, signalDeps(state.deploy, state.workStream))
  }

  // REAPER side: the real shouldParkBox, with keepAlive wired to the SAME
  // shared predicate (as production's squad-aware keepAlive does). candidate
  // .alwaysOn mirrors production, where state.alwaysOn === squad.isSandboxAlwaysOn.
  function reaperWouldPark(state: State): Promise<boolean> {
    const squad = squadFor(state)
    const keepAlive = () => shouldKeepSquadWarm(squad, NOW, signalDeps(state.deploy, state.workStream))
    const candidate: IdleCandidate = {
      sandboxId: 'squad_s1',
      boxStatus: 'ready',
      lastActivityAt: NOW - state.idleAgeMin * 60 * 1000,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      alwaysOn: state.alwaysOn,
    }
    return shouldParkBox(candidate, NOW, keepAlive)
  }

  test('for every (2^4 signals × idleAge) state: warmupWouldEnsure → !reaperWouldPark', async () => {
    const bools = [false, true]
    const idleAges = [5, 20, 45]
    let checked = 0
    for (const alwaysOn of bools) {
      for (const recentMsg of bools) {
        for (const deploy of bools) {
          for (const workStream of bools) {
            for (const idleAgeMin of idleAges) {
              const state: State = { alwaysOn, recentMsg, deploy, workStream, idleAgeMin }
              const ensure = await warmupWouldEnsure(state)
              const park = await reaperWouldPark(state)
              if (ensure && park) {
                throw new Error(`invariant violated: warmup ensures but reaper parks for ${JSON.stringify(state)}`)
              }
              checked++
            }
          }
        }
      }
    }
    expect(checked).toBe(2 * 2 * 2 * 2 * 3)
  })

  test('churn regression: agents messaged 20m ago, no deploy/work-stream, idle 20m → warmed AND not parked', async () => {
    const squad = makeSquad({ agentMsgMinutesAgo: 20 })
    const deps = signalDeps(false, false)

    expect(await shouldKeepSquadWarm(squad, NOW, deps)).toBe(true)

    const candidate: IdleCandidate = {
      sandboxId: 'squad_s1',
      boxStatus: 'ready',
      lastActivityAt: NOW - 20 * 60 * 1000,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      alwaysOn: false,
    }
    const park = await shouldParkBox(candidate, NOW, () => shouldKeepSquadWarm(squad, NOW, deps))
    expect(park).toBe(false)
  })
})
