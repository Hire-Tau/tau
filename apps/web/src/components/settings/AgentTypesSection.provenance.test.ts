import { describe, expect, test } from 'bun:test'
import { formatResolvedModel } from './modelTierUi'
describe('Agents model provenance', () => {
  test('renders a tier label without the resolved chain for tier-backed types', () =>
    expect(
      formatResolvedModel(
        { tier: 'deep', model: '', resolvedChain: 'openai:model:high', provenance: 'via tier: deep' },
        'Deep'
      )
    ).toBe('Model tier: Deep'))

  test('falls back to the tier slug when tier label data is unavailable', () =>
    expect(
      formatResolvedModel({ tier: 'deep', model: '', resolvedChain: 'openai:model:high', provenance: 'via tier: deep' })
    ).toBe('Model tier: deep'))

  test('renders override provenance exactly', () =>
    expect(
      formatResolvedModel({
        tier: 'deep',
        model: 'openai:model:low',
        resolvedChain: 'openai:model:low',
        provenance: 'type override',
      })
    ).toBe('Model: openai:model:low (type override)'))

  test('renders instance-default provenance exactly', () =>
    expect(
      formatResolvedModel({
        tier: null,
        model: '',
        resolvedChain: 'anthropic:claude-sonnet-4',
        provenance: 'instance default',
      })
    ).toBe('Model: anthropic:claude-sonnet-4 (instance default)'))
})
