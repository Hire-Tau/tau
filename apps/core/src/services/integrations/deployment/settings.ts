import { getSecretStore } from '../../secrets'
import { getSettingsStore } from '../../settings'
import type { SafeIntegrationCatalogEntry } from '../plugin'
import { readIntegrationCredentialFields, writeIntegrationCredentialFields } from '../credential-settings'

export const deploymentCredentialProviders = {
  cloudflare: {
    label: 'Cloudflare',
    key: 'DEPLOY_CLOUDFLARE_TOKEN',
    tokenLabel: 'API token',
    description: 'Deploy sites and Workers to Cloudflare.',
  },
  digitalocean: {
    label: 'DigitalOcean',
    key: 'DEPLOY_DIGITALOCEAN_TOKEN',
    tokenLabel: 'API token',
    description: 'Deploy apps, containers, and databases to DigitalOcean.',
  },
  netlify: {
    label: 'Netlify',
    key: 'DEPLOY_NETLIFY_TOKEN',
    tokenLabel: 'Personal access token',
    description: 'Deploy static sites and web apps to Netlify.',
  },
  railway: {
    label: 'Railway',
    key: 'DEPLOY_RAILWAY_TOKEN',
    tokenLabel: 'Account API token',
    description: 'Deploy services, containers, and databases to Railway.',
  },
  supabase: {
    label: 'Supabase',
    key: 'DEPLOY_SUPABASE_TOKEN',
    tokenLabel: 'Access token',
    description: 'Manage Supabase projects, databases, and Edge Functions.',
  },
  vercel: {
    label: 'Vercel',
    key: 'DEPLOY_VERCEL_TOKEN',
    tokenLabel: 'Access token',
    description: 'Deploy frontend and Next.js apps to Vercel.',
  },
} as const
export type DeploymentCredentialProvider = keyof typeof deploymentCredentialProviders
export function isDeploymentIntegration(provider: string): provider is DeploymentCredentialProvider {
  return Object.hasOwn(deploymentCredentialProviders, provider)
}
export function deploymentProviderForSecret(key: string): DeploymentCredentialProvider | undefined {
  return (Object.keys(deploymentCredentialProviders) as DeploymentCredentialProvider[]).find(
    (provider) => deploymentCredentialProviders[provider].key === key
  )
}
function fieldsFor(provider: string) {
  if (!isDeploymentIntegration(provider)) throw new Error('Unknown deployment integration')
  const entry = deploymentCredentialProviders[provider]
  return [
    {
      key: entry.key,
      required: true,
      label: entry.tokenLabel,
      secret: true,
      placeholder: `${entry.label} ${entry.tokenLabel.toLowerCase()}`,
    },
  ]
}
export const deploymentIntegrationCatalog: SafeIntegrationCatalogEntry[] = (
  Object.keys(deploymentCredentialProviders) as DeploymentCredentialProvider[]
).map((key) => ({
  manifestVersion: 1,
  key,
  adapterVersion: 1,
  label: deploymentCredentialProviders[key].label,
  description: deploymentCredentialProviders[key].description,
  icon: key,
  connectionMode: 'deployment',
  assignable: false,
  requiredCapabilities: [],
  sandbox: { packages: [], skills: [], extensions: [], protectedBindingNames: [] },
}))
export function getDeploymentIntegrationSettings(provider: string) {
  return readIntegrationCredentialFields(fieldsFor(provider))
}
export async function configureDeploymentIntegration(provider: string, input: unknown, actor: string) {
  const result = await writeIntegrationCredentialFields(fieldsFor(provider), input, actor)
  const { regenerateEnvFilesForSecretKey } = await import('../../squad/env')
  await regenerateEnvFilesForSecretKey(fieldsFor(provider)[0].key)
  return result
}

/** Keep existing squad allowlists; global disable withholds the credential from generated environments. */
export function getDeploymentAwareSecretValue(key: string): string | undefined {
  const provider = deploymentProviderForSecret(key)
  if (provider && getSettingsStore().getStoredValue(`__integration-enabled:${provider}`) === 'false') return undefined
  return getSecretStore().get(key)
}
export async function initializeDeploymentIntegrationStates() {
  const { db, settings } = await import('../../../db')
  for (const [provider, entry] of Object.entries(deploymentCredentialProviders)) {
    const key = `__integration-enabled:${provider}`
    await db
      .insert(settings)
      .values({ key, value: String(!!getSecretStore().get(entry.key)) })
      .onConflictDoNothing()
    await getSettingsStore().refreshKey(key)
  }
}
export async function setDeploymentIntegrationEnabled(provider: string, enabled: boolean, actor: string) {
  if (!isDeploymentIntegration(provider)) throw new Error('Unknown deployment integration')
  await getSettingsStore().set(`__integration-enabled:${provider}`, String(enabled), actor)
  const { regenerateEnvFilesForSecretKey } = await import('../../squad/env')
  await regenerateEnvFilesForSecretKey(deploymentCredentialProviders[provider].key)
  return { enabled }
}
