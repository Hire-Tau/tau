import { getSecretStore } from '../../secrets'
import { getSettingsStore } from '../../settings'
import { readIntegrationCredentialFields, writeIntegrationCredentialFields } from '../credential-settings'
import type { SafeIntegrationCatalogEntry } from '../plugin'

export const OPENAI_SERVICES_PROVIDER = 'openai-services'
export const OPENAI_SERVICES_ENABLED_KEY = '__integration-enabled:openai-services'
const fields = [{ key: 'OPENAI_API_KEY', required: true, label: 'API key', secret: true, placeholder: 'sk-…' }]
export const openAIServicesIntegrationCatalog: SafeIntegrationCatalogEntry = {
  manifestVersion: 1,
  key: OPENAI_SERVICES_PROVIDER,
  adapterVersion: 1,
  label: 'OpenAI API services',
  description: 'Use realtime voice, audio transcription, and memory embeddings independently of agent models.',
  icon: 'openai-services',
  connectionMode: 'service',
  assignable: false,
  requiredCapabilities: [],
  sandbox: { packages: [], skills: [], extensions: [], protectedBindingNames: [] },
}
export function getOpenAIServicesSettings() {
  return readIntegrationCredentialFields(fields)
}
export async function configureOpenAIServices(input: unknown, actor: string) {
  // This writes only the service key, never PROVIDER_AUTH_DATA or process.env.
  // AI Providers owns agent accounts and model fallback eligibility separately.
  return writeIntegrationCredentialFields(fields, input, actor)
}
export function getOpenAIServiceKey(): string | undefined {
  if (getSettingsStore().getStoredValue(OPENAI_SERVICES_ENABLED_KEY) === 'false') return undefined
  return getSecretStore().get('OPENAI_API_KEY')?.trim() || undefined
}
export async function initializeOpenAIServicesState() {
  const { db, settings } = await import('../../../db')
  await db
    .insert(settings)
    .values({ key: OPENAI_SERVICES_ENABLED_KEY, value: String(!!getSecretStore().get('OPENAI_API_KEY')?.trim()) })
    .onConflictDoNothing()
  await getSettingsStore().refreshKey(OPENAI_SERVICES_ENABLED_KEY)
}
export async function setOpenAIServicesEnabled(enabled: boolean, actor: string) {
  await getSettingsStore().set(OPENAI_SERVICES_ENABLED_KEY, String(enabled), actor)
  return { enabled }
}
