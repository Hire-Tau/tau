import { toSafeCatalogEntry, type IntegrationPluginV1, type SafeIntegrationCatalogEntry } from './plugin'
import type { IntegrationCapabilities, IntegrationCapabilityKind, IntegrationProvider } from './types'

export interface IntegrationRegistryOptions {
  plugins: readonly IntegrationPluginV1<any, any, any>[]
  compatibilityProviders: readonly IntegrationProvider[]
}

export class IntegrationRegistry {
  readonly providers: readonly IntegrationProvider[]
  readonly #plugins: readonly IntegrationPluginV1<any, any, any>[]
  readonly #byKey: ReadonlyMap<string, IntegrationProvider>
  readonly #pluginByKey: ReadonlyMap<string, IntegrationPluginV1<any, any, any>>

  constructor(options: IntegrationRegistryOptions) {
    const byKey = new Map<string, IntegrationProvider>()
    const pluginByKey = new Map<string, IntegrationPluginV1<any, any, any>>()
    for (const plugin of options.plugins) {
      if (byKey.has(plugin.key)) throw new Error(`Duplicate integration provider: ${plugin.key}`)
      if (
        plugin.runtime.provider.key !== plugin.key ||
        plugin.runtime.provider.adapterVersion !== plugin.adapterVersion
      ) {
        throw new Error(`Integration plugin provider identity mismatch: ${plugin.key}`)
      }
      byKey.set(plugin.key, plugin.runtime.provider)
      pluginByKey.set(plugin.key, plugin)
    }
    for (const provider of options.compatibilityProviders) {
      if (byKey.has(provider.key)) throw new Error(`Duplicate integration provider: ${provider.key}`)
      byKey.set(provider.key, provider)
    }
    this.#plugins = Object.freeze([...options.plugins])
    this.providers = Object.freeze([...byKey.values()])
    this.#byKey = byKey
    this.#pluginByKey = pluginByKey
  }

  plugins(): readonly IntegrationPluginV1<any, any, any>[] {
    return this.#plugins
  }

  plugin(key: string): IntegrationPluginV1<any, any, any> | undefined {
    return this.#pluginByKey.get(key)
  }

  catalog(): readonly SafeIntegrationCatalogEntry[] {
    return this.#plugins.map((plugin) => toSafeCatalogEntry(plugin))
  }

  get(key: string): IntegrationProvider | undefined {
    return this.#byKey.get(key)
  }

  require(key: string, adapterVersion: number): IntegrationProvider {
    const provider = this.get(key)
    if (!provider) throw new Error(`Unknown integration provider: ${key}`)
    if (provider.adapterVersion !== adapterVersion) {
      throw new Error(`Unsupported integration adapter version: ${key}@${adapterVersion}`)
    }
    return provider
  }

  capability<K extends IntegrationCapabilityKind>(
    key: string,
    adapterVersion: number,
    capability: K
  ): IntegrationCapabilities[K] | undefined {
    return this.require(key, adapterVersion).capabilities[capability] as IntegrationCapabilities[K] | undefined
  }
}
