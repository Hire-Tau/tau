import { describe, expect, test } from 'bun:test'
import { resolveAgentModelSpec } from '../utils/model-spec'
import { MODEL_OVERRIDE_PROMPT_PROVIDERS } from './model-overrides-prompt'

describe('buildModelOverridePrompt', () => {
  test('only advertises models that exist in the bundled SDK catalog', () => {
    for (const { provider, models } of MODEL_OVERRIDE_PROMPT_PROVIDERS) {
      for (const model of models) {
        expect(() => resolveAgentModelSpec(`${provider}:${model}`, undefined)).not.toThrow()
      }
    }
  })
})
