import { describe, expect, test } from 'bun:test'
import { inspectTierCapabilities } from './tier-capability-policy'
const account = {
  providerId: 'local',
  model: 'qwen',
  capabilities: { tools: false, contextWindow: 8192, probedAt: 'now' },
}
describe('tier capability policy', () => {
  test('refuses a tool-less model in primary position', () => {
    expect(inspectTierCapabilities('local:qwen,openai:gpt', [account], 16384).errors).toContain(
      'Tool-less model local:qwen cannot be Primary'
    )
  })
  test('warns for tool-less non-last position and small context', () => {
    const result = inspectTierCapabilities('openai:gpt,local:qwen,zai:glm', [account], 16384)
    expect(result.warnings).toContain('Tool-less model local:qwen is not a last-resort fallback')
    expect(result.warnings).toContain('Model local:qwen context window 8192 is below 16384')
  })
  test('allows tool-less model only as last-resort fallback', () => {
    expect(inspectTierCapabilities('openai:gpt,local:qwen', [account], 4096).errors).toEqual([])
  })
})
