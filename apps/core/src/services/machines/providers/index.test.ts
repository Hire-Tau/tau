import { describe, expect, it } from 'bun:test'
import type { MachineProvider } from '../provider'
import { registerBuiltinMachineProviders } from './index'

/**
 * registerBuiltinMachineProviders always registers BYO-SSH and conditionally
 * registers the exe provider — only when an exe.dev account SSH key is
 * configured. Both the key reader and the registry sink are injected so these
 * assertions never mutate the real module-level registry.
 */
function collector() {
  const keys: string[] = []
  return { keys, register: (p: MachineProvider) => keys.push(p.key) }
}

describe('registerBuiltinMachineProviders', () => {
  it('registers the exe provider when an account SSH key is configured', async () => {
    const { keys, register } = collector()
    await registerBuiltinMachineProviders({ register, getSshKey: async () => 'ssh-key' })
    expect(keys).toContain('ssh')
    expect(keys).toContain('exe')
  })

  it('registers only ssh when no account SSH key is configured', async () => {
    const { keys, register } = collector()
    await registerBuiltinMachineProviders({ register, getSshKey: async () => null })
    expect(keys).toEqual(['ssh'])
  })

  it('does not throw and is idempotent when called twice without a key', async () => {
    const { keys, register } = collector()
    await registerBuiltinMachineProviders({ register, getSshKey: async () => null })
    await registerBuiltinMachineProviders({ register, getSshKey: async () => null })
    expect(keys).toEqual(['ssh', 'ssh'])
  })
})
