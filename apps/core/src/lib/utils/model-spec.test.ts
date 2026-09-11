import { describe, expect, it } from 'bun:test'
import {
  parseModelSpec,
  parseModelPriorityList,
  resolveAgentModelSpec,
  resolveModelSpec,
  splitModelPriorityList,
  supportsImageInput,
  validateModelSpec,
  validateModelSpecList,
} from './model-spec'

describe('model-spec', () => {
  describe('colon-bearing model ids', () => {
    it('preserves a colon tag in the model id', () =>
      expect(parseModelSpec('ollama:llama3.2:latest')).toEqual({
        provider: 'ollama',
        modelId: 'llama3.2:latest',
        thinkingLevel: undefined,
      }))
    it('parses thinking after a colon-bearing model id', () =>
      expect(parseModelSpec('ollama:llama3.2:latest:high')).toEqual({
        provider: 'ollama',
        modelId: 'llama3.2:latest',
        thinkingLevel: 'high',
      }))
  })

  describe('parseModelSpec', () => {
    it('parses provider:model format', () => {
      expect(parseModelSpec('anthropic:claude-sonnet-4-5')).toEqual({
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        thinkingLevel: undefined,
      })
    })

    it('parses provider/model format', () => {
      expect(parseModelSpec('anthropic/claude-sonnet-4-5')).toEqual({
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        thinkingLevel: undefined,
      })
    })

    it('parses optional thinking level from provider:model:thinking format', () => {
      expect(parseModelSpec('openai-codex:gpt-5.6-sol:high')).toEqual({
        provider: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        thinkingLevel: 'high',
      })
    })

    it('parses optional thinking level from provider/model:thinking format', () => {
      expect(parseModelSpec('openai-codex/gpt-5.6-sol:xhigh')).toEqual({
        provider: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        thinkingLevel: 'xhigh',
      })
    })

    it('keeps the vendor slash inside an OpenRouter model id and preserves effort', () => {
      expect(parseModelSpec('openrouter:openai/gpt-5.6-sol:batch:high')).toEqual({
        provider: 'openrouter',
        modelId: 'openai/gpt-5.6-sol:batch',
        thinkingLevel: 'high',
      })
    })

    it('preserves an unrecognized suffix as part of a colon-bearing model id', () => {
      expect(parseModelSpec('openai-codex:gpt-5.6-sol:maximum').modelId).toBe('gpt-5.6-sol:maximum')
    })

    it('rejects model without provider', () => {
      expect(() => parseModelSpec('claude-sonnet-4-5')).toThrow("must be 'provider:model-id'")
    })
  })

  describe('dynamic model catalog validation', () => {
    const model = { id: 'llama3.2:latest', provider: 'local' } as any
    const catalog = {
      getModel: (provider: string, modelId: string) =>
        provider === 'local' && modelId === model.id ? model : undefined,
      getProviders: () => [{ id: 'local' }],
    }
    it('validates a dynamically registered colon-bearing local model', () =>
      expect(validateModelSpec('local:llama3.2:latest', catalog)).toMatchObject({
        provider: 'local',
        modelId: 'llama3.2:latest',
      }))
    it('rejects an unknown model from a dynamic provider', () =>
      expect(() => validateModelSpec('local:missing', catalog)).toThrow("Unknown provider 'local'"))
  })

  describe('validateModelSpec', () => {
    it('validates known provider/model', () => {
      expect(validateModelSpec('anthropic:claude-sonnet-4-5')).toEqual({
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        thinkingLevel: undefined,
      })
    })

    it('rejects unknown provider', () => {
      expect(() => validateModelSpec('fake:claude-sonnet-4-5')).toThrow("Unknown provider 'fake'")
    })
  })

  describe('supportsImageInput', () => {
    it('returns false for models whose registry input modalities omit image', () => {
      expect(supportsImageInput('zai:glm-5.2')).toBe(false)
    })

    it('returns true for models whose registry input modalities include image', () => {
      expect(supportsImageInput('anthropic:claude-sonnet-4-5')).toBe(true)
    })

    it('uses the selected single model spec rather than other priority-list fallbacks', () => {
      expect(supportsImageInput('zai:glm-5.2:high')).toBe(false)
    })
  })

  describe('OpenRouter backend pinning', () => {
    it('pins the creator backend family and disables OpenRouter-side fallback', () => {
      const { model } = resolveAgentModelSpec('openrouter:anthropic/claude-sonnet-5:high')
      expect((model.compat as any)?.openRouterRouting).toEqual({
        only: ['anthropic'],
        order: ['anthropic'],
        allow_fallbacks: false,
        require_parameters: true,
      })
    })

    it('uses verified endpoint families for Google, DeepSeek, and Xiaomi', () => {
      for (const [spec, endpoint] of [
        ['openrouter:google/gemini-2.5-pro:high', 'google-ai-studio'],
        ['openrouter:deepseek/deepseek-v4-flash', 'streamlake'],
        ['openrouter:xiaomi/mimo-v2.5-pro', 'xiaomi'],
      ] as const) {
        const { model } = resolveAgentModelSpec(spec)
        expect((model.compat as any)?.openRouterRouting).toEqual({
          only: [endpoint],
          order: [endpoint],
          allow_fallbacks: false,
          require_parameters: true,
        })
      }
    })
  })

  describe('resolveModelSpec', () => {
    it('resolves a model with provider + id', () => {
      const model = resolveModelSpec('anthropic:claude-sonnet-4-5')
      expect(model.provider).toBe('anthropic')
      expect(model.id).toBe('claude-sonnet-4-5')
    })

    it('resolves a model with thinking level', () => {
      const result = resolveAgentModelSpec('openai-codex:gpt-5.6-sol:high')
      expect(result.model.provider).toBe('openai-codex')
      expect(result.model.id).toBe('gpt-5.6-sol')
      expect(result.thinkingLevel).toBe('high')
    })
  })
})

describe('model priority lists', () => {
  describe('splitModelPriorityList', () => {
    it('returns a single-element list for a single spec', () => {
      expect(splitModelPriorityList('anthropic:claude-sonnet-4-5')).toEqual(['anthropic:claude-sonnet-4-5'])
    })

    it('splits a comma-separated list and trims whitespace', () => {
      expect(
        splitModelPriorityList(' zai:glm-5.2:high , openai-codex:gpt-5.6-sol:low ,anthropic:claude-sonnet-4-6 ')
      ).toEqual(['zai:glm-5.2:high', 'openai-codex:gpt-5.6-sol:low', 'anthropic:claude-sonnet-4-6'])
    })

    it('drops empty entries', () => {
      expect(splitModelPriorityList('anthropic:claude-sonnet-4-5,, ,')).toEqual(['anthropic:claude-sonnet-4-5'])
    })

    it('rejects an empty/whitespace-only string', () => {
      expect(() => splitModelPriorityList('')).toThrow('non-empty')
      expect(() => splitModelPriorityList('   ')).toThrow('non-empty')
      expect(() => splitModelPriorityList(' ,, ')).toThrow('non-empty')
    })
  })

  describe('parseModelPriorityList', () => {
    it('parses every candidate in the list', () => {
      expect(parseModelPriorityList('zai:glm-5.2:high,anthropic:claude-sonnet-4-6')).toEqual([
        { provider: 'zai', modelId: 'glm-5.2', thinkingLevel: 'high' },
        { provider: 'anthropic', modelId: 'claude-sonnet-4-6', thinkingLevel: undefined },
      ])
    })

    it('treats a single spec as a one-element list (backward compat)', () => {
      expect(parseModelPriorityList('anthropic:claude-sonnet-4-5')).toEqual([
        { provider: 'anthropic', modelId: 'claude-sonnet-4-5', thinkingLevel: undefined },
      ])
    })

    it('propagates parse errors for an invalid candidate', () => {
      expect(() => parseModelPriorityList('anthropic:claude-sonnet-4-5,bad')).toThrow("must be 'provider:model-id'")
    })
  })

  describe('validateModelSpecList', () => {
    it('validates every candidate structurally (provider + model known)', () => {
      const parsed = validateModelSpecList('zai:glm-5.2:high,anthropic:claude-sonnet-4-5')
      expect(parsed).toEqual([
        { provider: 'zai', modelId: 'glm-5.2', thinkingLevel: 'high' },
        { provider: 'anthropic', modelId: 'claude-sonnet-4-5', thinkingLevel: undefined },
      ])
    })

    it('validates a single spec (backward compat)', () => {
      expect(validateModelSpecList('anthropic:claude-sonnet-4-5')).toEqual([
        { provider: 'anthropic', modelId: 'claude-sonnet-4-5', thinkingLevel: undefined },
      ])
    })

    it('rejects when any candidate has an unknown provider', () => {
      expect(() => validateModelSpecList('anthropic:claude-sonnet-4-5,fake:claude-sonnet-4-5')).toThrow(
        "Unknown provider 'fake'"
      )
    })

    it('rejects when any candidate has an unknown model', () => {
      expect(() => validateModelSpecList('anthropic:not-a-real-model')).toThrow("Unknown model 'not-a-real-model'")
    })
  })
})
