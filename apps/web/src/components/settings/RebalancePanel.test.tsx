import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RebalancePlanView, rebalanceErrorMessage } from './RebalancePanel'
import type { Machine, RebalancePlan } from '../../api/machines'

function machine(id: string, name: string): Machine {
  return {
    id,
    name,
    provider: 'ssh',
    providerRef: null,
    sshHost: 'h',
    sshPort: 22,
    sshUser: 'root',
    sshPublicKey: 'ssh-ed25519 AAAA',
    status: 'ready',
    capabilities: {},
    scope: 'shared',
    purpose: 'shared',
    squadId: null,
    egressPolicy: false,
    bootstrapVersion: null,
    artifactVersions: {},
    utilization: { unitsUsed: 0, unitCapacity: 4 },
    lastSeenAt: null,
    createdAt: '2026-07-19T00:00:00.000Z',
  }
}

const emptyPlan: Omit<RebalancePlan, 'moves'> = {
  skippedActive: [],
  unplaceable: [],
  unresolvable: [],
  results: [],
}

describe('RebalancePlanView', () => {
  test('renders the moves list with resolved machine names', () => {
    const machines = [machine('m1', 'alpha'), machine('m2', 'beta')]
    const plan: RebalancePlan = {
      ...emptyPlan,
      moves: [{ sandboxId: 'sbx-1', fromMachineId: 'm1', toMachineId: 'm2' }],
    }
    const html = renderToStaticMarkup(<RebalancePlanView plan={plan} machines={machines} />)
    expect(html).toContain('sbx-1')
    expect(html).toContain('alpha')
    expect(html).toContain('beta')
    expect(html).toContain('1 move planned')
  })

  test('falls back to the id for a synthetic provision target', () => {
    const plan: RebalancePlan = {
      ...emptyPlan,
      moves: [{ sandboxId: 'sbx-1', fromMachineId: 'm1', toMachineId: 'provision:0' }],
    }
    const html = renderToStaticMarkup(<RebalancePlanView plan={plan} machines={[machine('m1', 'alpha')]} />)
    expect(html).toContain('provision:0')
  })

  test('shows non-zero skipped/unplaceable counts', () => {
    const plan: RebalancePlan = {
      ...emptyPlan,
      moves: [{ sandboxId: 'sbx-1', fromMachineId: 'm1', toMachineId: 'm2' }],
      skippedActive: ['sbx-9'],
      unplaceable: ['sbx-8'],
    }
    const html = renderToStaticMarkup(<RebalancePlanView plan={plan} machines={[]} />)
    expect(html).toContain('1 skipped (active turn)')
    expect(html).toContain('1 unplaceable')
  })

  test('renders the balanced case when there are no moves', () => {
    const plan: RebalancePlan = { ...emptyPlan, moves: [] }
    const html = renderToStaticMarkup(<RebalancePlanView plan={plan} machines={[]} />)
    expect(html).toContain('Fleet is balanced.')
  })
})

describe('rebalanceErrorMessage', () => {
  test('maps a 409 to the already-running hint', () => {
    expect(rebalanceErrorMessage(new Error('API error: 409: rebalance already running'))).toBe(
      'A rebalance is already running.'
    )
  })

  test('passes any other error message through verbatim', () => {
    expect(rebalanceErrorMessage(new Error('API error: 500: boom'))).toBe('API error: 500: boom')
  })
})
