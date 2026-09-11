import { describe, expect, it } from 'bun:test'
import { PROVIDER_LABEL_OVERRIDES, providerLabel } from './providers'

describe('providerLabel', () => {
  it('returns the override label for known provider ids', () => {
    expect(providerLabel('zai')).toBe('Z.ai')
    expect(providerLabel('openai-codex')).toBe('OpenAI Codex')
    expect(providerLabel('huggingface')).toBe('Hugging Face')
    expect(providerLabel('openrouter')).toBe('OpenRouter')
  })

  it('title-cases unknown ids by default', () => {
    expect(providerLabel('anthropic')).toBe('Anthropic')
    expect(providerLabel('google')).toBe('Google')
    expect(providerLabel('custom-provider')).toBe('Custom Provider')
  })

  it('returns the raw id unchanged for empty input', () => {
    expect(providerLabel('')).toBe('')
  })

  it('exposes the overrides map for lookup', () => {
    expect(PROVIDER_LABEL_OVERRIDES['zai']).toBe('Z.ai')
  })
})
