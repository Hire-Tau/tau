import { toSafeCatalogEntry, type IntegrationPluginV1 } from './plugin'

export interface IntegrationPluginContractFixtures<C, Credential> {
  validConfiguration: C
  invalidConfigurations: readonly unknown[]
  credential: Credential
  secretSentinels: readonly string[]
}

/** Reusable first-party manifest contract. Throws only fixed, non-secret diagnostics. */
export function assertIntegrationPluginContract<C, Credential>(
  plugin: IntegrationPluginV1<C, Credential, any>,
  fixtures: IntegrationPluginContractFixtures<C, Credential>
): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(plugin.key)) throw new Error('Invalid integration plugin identity')
  if (plugin.manifestVersion !== 1 || !Number.isSafeInteger(plugin.adapterVersion) || plugin.adapterVersion < 1) {
    throw new Error('Invalid integration plugin version')
  }

  const configuration = plugin.connection.parseConfiguration(fixtures.validConfiguration)
  for (const invalid of fixtures.invalidConfigurations) {
    try {
      plugin.connection.parseConfiguration(invalid)
    } catch {
      continue
    }
    throw new Error('Integration configuration parser accepted invalid input')
  }

  const serializedCredential = plugin.connection.credential.serialize(fixtures.credential)
  plugin.connection.credential.parse(serializedCredential)
  const safeValues = JSON.stringify({
    catalog: toSafeCatalogEntry(plugin as IntegrationPluginV1<unknown, unknown>),
    configuration: plugin.connection.safeConfiguration(configuration),
    sandbox: plugin.sandbox,
    failure: plugin.classifyError(new Error('provider failure')),
  })
  for (const sentinel of fixtures.secretSentinels) {
    if (safeValues.includes(sentinel)) throw new Error('Integration plugin safe projection exposed a credential')
  }
  if (
    safeValues !==
    JSON.stringify({
      catalog: toSafeCatalogEntry(plugin as IntegrationPluginV1<unknown, unknown>),
      configuration: plugin.connection.safeConfiguration(configuration),
      sandbox: plugin.sandbox,
      failure: plugin.classifyError(new Error('provider failure')),
    })
  )
    throw new Error('Integration plugin projection is not deterministic')

  const classified = plugin.classifyError(new Error(fixtures.secretSentinels.join(',')))
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(classified.code)) throw new Error('Invalid provider error classification')
  if (JSON.stringify(classified).includes(fixtures.secretSentinels.join(','))) {
    throw new Error('Integration plugin error classification exposed a credential')
  }
}
