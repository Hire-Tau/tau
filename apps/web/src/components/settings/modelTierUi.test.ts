import { describe, expect, test } from 'bun:test'
import { assignCompatibleProvider, withTierPosition } from './modelTierUi'
describe('inline tier assignment', () => {
  test('uses the same chain representation as tier editing for Primary', () =>
    expect(withTierPosition('openai:gpt:high,zai:glm:high', 'openai-compatible:qwen', 'primary')).toBe(
      'openai-compatible:qwen,openai:gpt:high,zai:glm:high'
    ))
  test('uses explicit last fallback position without duplicating entries', () =>
    expect(withTierPosition('openai-compatible:qwen,openai:gpt:high', 'openai-compatible:qwen', 'fallback')).toBe(
      'openai:gpt:high,openai-compatible:qwen'
    ))
})
test('inline assignment writes previewed chains through the tier write path', async () => {
  const writes: string[] = []
  const { assignCompatibleProvider } = await import('./modelTierUi')
  await assignCompatibleProvider({
    tiers: [{ slug: 'fast', chain: 'openai:gpt:low' }],
    spec: 'local:qwen',
    position: 'primary',
    add: async () => {},
    update: async (tier) => {
      writes.push(tier.chain)
    },
    rollbackProvider: async () => {},
  })
  expect(writes).toEqual(['local:qwen,openai:gpt:low'])
})

describe('inline assignment compensation', () => {
  const tiers = [
    { slug: 'fast', chain: 'old-fast' },
    { slug: 'deep', chain: 'old-deep' },
  ]
  test('restores tiers and removes provider after update failure', async () => {
    const writes: string[] = []
    let deleted = false
    await expect(
      assignCompatibleProvider({
        tiers,
        spec: 'local:qwen',
        position: 'primary',
        add: async () => {},
        update: async (tier) => {
          writes.push(`${tier.slug}:${tier.chain}`)
          if (tier.slug === 'deep' && tier.chain !== 'old-deep') throw new Error('write failed')
        },
        rollbackProvider: async () => {
          deleted = true
        },
      })
    ).rejects.toThrow('fully rolled back')
    expect(writes).toContain('fast:old-fast')
    expect(writes).toContain('deep:old-deep')
    expect(deleted).toBe(true)
  })
  test('retains provider when tier restore fails', async () => {
    let deleted = false
    await expect(
      assignCompatibleProvider({
        tiers,
        spec: 'local:qwen',
        position: 'primary',
        add: async () => {},
        update: async (tier) => {
          if (tier.slug === 'deep' && tier.chain !== 'old-deep') throw new Error('write failed')
          if (tier.slug === 'fast' && tier.chain === 'old-fast') throw new Error('restore failed')
        },
        rollbackProvider: async () => {
          deleted = true
        },
      })
    ).rejects.toThrow('tiers fast could not be restored; provider retained')
    expect(deleted).toBe(false)
  })
  test('reports provider removal failure precisely', async () => {
    await expect(
      assignCompatibleProvider({
        tiers,
        spec: 'local:qwen',
        position: 'primary',
        add: async () => {},
        update: async (tier) => {
          if (tier.slug === 'deep' && tier.chain !== 'old-deep') throw new Error('write failed')
        },
        rollbackProvider: async () => {
          throw new Error('delete failed')
        },
      })
    ).rejects.toThrow('provider removal failed; provider retained')
  })
})
