import { describe, expect, test } from 'bun:test'
import { isModelPriorityList, parseDisplayModelPriorityList, parseDisplayModelSpec } from './displayModelSpec'

describe('parseDisplayModelSpec', () => {
  test('parses provider, model id, and thinking level from colon specs', () => {
    expect(parseDisplayModelSpec('anthropic:claude-sonnet-4-5:high')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      thinkingLevel: 'high',
    })
  })

  test('parses provider, model id, and thinking level from slash specs', () => {
    expect(parseDisplayModelSpec('zai/glm-5.2:xhigh')).toEqual({
      provider: 'zai',
      modelId: 'glm-5.2',
      thinkingLevel: 'xhigh',
    })
  })

  test('preserves colons in model ids when suffix is not a thinking level', () => {
    expect(parseDisplayModelSpec('custom:model:preview')).toEqual({
      provider: 'custom',
      modelId: 'model:preview',
      thinkingLevel: undefined,
    })
  })
})

describe('isModelPriorityList', () => {
  test('returns false for a single spec', () => {
    expect(isModelPriorityList('anthropic:claude-sonnet-4-5')).toBe(false)
  })

  test('returns true for a comma-separated list', () => {
    expect(isModelPriorityList('zai:glm-5.2:high,anthropic:claude-sonnet-4-6')).toBe(true)
  })

  test('ignores empty/whitespace-only entries', () => {
    expect(isModelPriorityList('anthropic:claude-sonnet-4-5, , ')).toBe(false)
  })
})

describe('parseDisplayModelPriorityList', () => {
  test('returns a one-element list for a single spec', () => {
    expect(parseDisplayModelPriorityList('anthropic:claude-sonnet-4-5:high')).toEqual([
      { provider: 'anthropic', modelId: 'claude-sonnet-4-5', thinkingLevel: 'high' },
    ])
  })

  test('parses every candidate in a priority list, preserving order', () => {
    expect(
      parseDisplayModelPriorityList(' zai:glm-5.2:high , openai-codex:gpt-5.5:low ,anthropic:claude-sonnet-4-6 ')
    ).toEqual([
      { provider: 'zai', modelId: 'glm-5.2', thinkingLevel: 'high' },
      { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'low' },
      { provider: 'anthropic', modelId: 'claude-sonnet-4-6', thinkingLevel: undefined },
    ])
  })
})

test('OpenRouter model namespaces stay inside the model ID', () => {
  expect(parseDisplayModelSpec('openrouter:anthropic/claude:high')).toEqual({
    provider: 'openrouter',
    modelId: 'anthropic/claude',
    thinkingLevel: 'high',
  })
  expect(parseDisplayModelSpec('openai:gpt:max').thinkingLevel).toBe('max')
})
