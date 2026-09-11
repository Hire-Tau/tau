import { describe, expect, test } from 'bun:test'
import type { IntegrationPluginV1 } from './plugin'
import { IntegrationRegistry } from './registry'
import type { IntegrationProvider } from './types'

function fakeProvider(
  key: string,
  adapterVersion = 1,
  capabilities: IntegrationProvider['capabilities'] = {}
): IntegrationProvider {
  return {
    key,
    adapterVersion,
    parseConfig: (value) => value,
    validate: async () => ({ ok: true, grantedScopes: [] }),
    capabilities,
  }
}

function fakePlugin(key: string, adapterVersion = 1): IntegrationPluginV1<unknown, string> {
  const provider = fakeProvider(key, adapterVersion)
  return {
    manifestVersion: 1,
    key,
    adapterVersion,
    presentation: {
      label: key,
      description: `${key} integration`,
      icon: 'bigbrain',
      connectionMode: 'credential',
      assignable: true,
      requiredCapabilities: [],
    },
    connection: {
      parseConfiguration: (value) => value,
      safeConfiguration: (value) => value,
      credential: { parse: (value) => String(value), serialize: (value) => value },
    },
    authorization: { kind: 'manual' },
    runtime: { provider },
    sandbox: {
      packages: [],
      setupSteps: [],
      initHooks: [],
      readiness: [],
      skills: [],
      extensions: [],
      protectedBindings: [],
    },
    lifecycle: { refresh: false, revoke: false },
    classifyError: () => ({ code: 'provider_error', retryable: true }),
  }
}

describe('IntegrationRegistry', () => {
  test('requires the exact plugin adapter version', () => {
    const plugin = fakePlugin('bigbrain')
    const registry = new IntegrationRegistry({ plugins: [plugin], compatibilityProviders: [] })

    expect(registry.get('bigbrain')).toBe(plugin.runtime.provider)
    expect(registry.require('bigbrain', 1)).toBe(plugin.runtime.provider)
    expect(() => registry.require('bigbrain', 2)).toThrow('Unsupported integration adapter version')
    expect(() => registry.require('missing', 1)).toThrow('Unknown integration provider')
  })

  test('rejects duplicate plugin keys even when adapter versions differ', () => {
    expect(
      () =>
        new IntegrationRegistry({
          plugins: [fakePlugin('bigbrain', 1), fakePlugin('bigbrain', 2)],
          compatibilityProviders: [],
        })
    ).toThrow('Duplicate integration provider')
  })

  test('rejects identities duplicated across plugin and compatibility registries', () => {
    expect(
      () =>
        new IntegrationRegistry({ plugins: [fakePlugin('github')], compatibilityProviders: [fakeProvider('github')] })
    ).toThrow('Duplicate integration provider')
  })

  test('publishes only safe first-party catalog entries', () => {
    const registry = new IntegrationRegistry({
      plugins: [fakePlugin('bigbrain')],
      compatibilityProviders: [fakeProvider('github')],
    })

    expect(registry.plugins()).toHaveLength(1)
    expect(registry.catalog()).toEqual([
      {
        manifestVersion: 1,
        key: 'bigbrain',
        adapterVersion: 1,
        label: 'bigbrain',
        description: 'bigbrain integration',
        icon: 'bigbrain',
        connectionMode: 'credential',
        assignable: true,
        requiredCapabilities: [],
        sandbox: { packages: [], skills: [], extensions: [], protectedBindingNames: [] },
      },
    ])
    expect(JSON.stringify(registry.catalog())).not.toContain('parseConfiguration')
    expect(JSON.stringify(registry.catalog())).not.toContain('credentialRef')
  })

  test('preserves hidden GitHub get, require, and capability semantics', () => {
    const eventPolling = {
      poll: async () => ({ events: [], nextCursor: { checkpoint: 1 }, suggestedIntervalMs: 60_000 }),
    }
    const github = fakeProvider('github', 1, { event_polling: eventPolling })
    const registry = new IntegrationRegistry({ plugins: [fakePlugin('bigbrain')], compatibilityProviders: [github] })

    expect(registry.catalog().some((entry) => entry.key === 'github')).toBe(false)
    expect(registry.get('github')).toBe(github)
    expect(registry.require('github', 1)).toBe(github)
    expect(registry.capability('github', 1, 'event_polling')).toBe(eventPolling)
  })

  test('copies constructor input instead of retaining mutable registry state', () => {
    const plugins = [fakePlugin('bigbrain')]
    const compatibilityProviders = [fakeProvider('github')]
    const registry = new IntegrationRegistry({ plugins, compatibilityProviders })
    plugins.push(fakePlugin('other'))
    compatibilityProviders.push(fakeProvider('other-compat'))

    expect(registry.get('other')).toBeUndefined()
    expect(registry.get('other-compat')).toBeUndefined()
    expect(Object.isFrozen(registry.providers)).toBe(true)
    expect(Object.isFrozen(registry.plugins())).toBe(true)
  })
})
