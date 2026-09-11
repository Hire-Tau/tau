import { describe, expect, test } from 'bun:test'
import { resolveModelChain } from './model-tier-resolution'

describe('resolveModelChain', () => {
  const tier = { slug: 'deep', chain: 'tier:model:high' }
  const fallback = 'default:model:medium'

  test('uses agent override before every other source', () => {
    expect(
      resolveModelChain({
        agentOverride: 'agent:model:xhigh',
        typeOverride: 'type:model:high',
        tier,
        instanceDefault: fallback,
      })
    ).toEqual({ chain: 'agent:model:xhigh', provenance: 'agent override' })
  })
  test('uses type override before tier', () => {
    expect(resolveModelChain({ typeOverride: 'type:model:high', tier, instanceDefault: fallback })).toEqual({
      chain: 'type:model:high',
      provenance: 'type override',
    })
  })
  test('uses tier chain before instance default', () => {
    expect(resolveModelChain({ tier, instanceDefault: fallback })).toEqual({
      chain: tier.chain,
      provenance: 'via tier: deep',
    })
  })
  test('missing tier falls through to instance default', () => {
    expect(resolveModelChain({ tier: null, tierSlug: 'removed', instanceDefault: fallback })).toEqual({
      chain: fallback,
      provenance: 'instance default',
    })
  })
  test('ignores empty overrides', () => {
    expect(resolveModelChain({ agentOverride: ' ', typeOverride: '', tier, instanceDefault: fallback }).chain).toBe(
      tier.chain
    )
  })
})
