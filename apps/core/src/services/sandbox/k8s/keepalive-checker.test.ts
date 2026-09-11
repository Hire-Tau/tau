import { describe, expect, test } from 'bun:test'
import { buildIdleKeepAliveChecker } from './manager'

describe('buildIdleKeepAliveChecker', () => {
  test('keeps alive when a local deployment is active', async () => {
    const checker = buildIdleKeepAliveChecker({
      hasActiveLocalDeployments: async () => true,
      hasRecentWorkStreamActivity: async () => false,
    })
    expect(await checker('agent_x')).toBe(true)
  })

  test('keeps alive when the work stream is recently active', async () => {
    const checker = buildIdleKeepAliveChecker({
      hasActiveLocalDeployments: async () => false,
      hasRecentWorkStreamActivity: async () => true,
    })
    expect(await checker('agent_x')).toBe(true)
  })

  test('allows idle termination when neither is active', async () => {
    const checker = buildIdleKeepAliveChecker({
      hasActiveLocalDeployments: async () => false,
      hasRecentWorkStreamActivity: async () => false,
    })
    expect(await checker('agent_x')).toBe(false)
  })
})
