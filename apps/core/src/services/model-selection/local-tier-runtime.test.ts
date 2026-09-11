import { describe, expect, test } from 'bun:test'
import type { Api, Model } from '@earendil-works/pi-ai'
import { resolveAgentModelSpec, type DynamicModelCatalog } from '../../lib/utils/model-spec'
import { ModelTierSync } from '../config-sync/model-tier-sync'

const provider = 'local-tier-test'
const model = {
  id: 'llama3.2:latest',
  provider,
  name: 'Local',
  api: 'openai-completions',
  baseUrl: 'http://localhost:8080/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 4096,
} as Model<Api>
const runtime: DynamicModelCatalog = {
  getModel: (candidateProvider, modelId) =>
    candidateProvider === provider && modelId === model.id ? model : undefined,
  getProviders: () => [{ id: provider }],
}
describe('local tier runtime integration', () => {
  test('validates a dynamic colon-bearing tier model and resolves it for an agent session', () => {
    const parsed = new ModelTierSync(runtime).parse(
      `slug: local-test\nlabel: Local\nchain: ${provider}:llama3.2:latest\nsortOrder: 1\n`
    )
    expect(parsed.chain).toBe(`${provider}:llama3.2:latest`)
    const resolved = resolveAgentModelSpec(parsed.chain, runtime)
    expect(resolved.model.provider).toBe(provider)
    expect(resolved.model.id).toBe('llama3.2:latest')
  })
})
