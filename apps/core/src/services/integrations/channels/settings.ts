import { readIntegrationCredentialFields, writeIntegrationCredentialFields } from '../credential-settings'
import { getSecretStore } from '../../secrets'
import { getSettingsStore } from '../../settings'
import type { SafeIntegrationCatalogEntry } from '../plugin'

// Channel transports still consume these encrypted keys. Their management API
// and presentation belong to integrations; transport/connection migration is separate.
export const channelIntegrationFields = {
  discord: [
    { key: 'DISCORD_BOT_TOKEN', required: true, label: 'Bot token', secret: true, placeholder: 'Discord bot token' },
    {
      key: 'DISCORD_APPLICATION_ID',
      required: true,
      label: 'Application ID',
      secret: false,
      placeholder: '123456789012345678',
    },
    {
      key: 'DISCORD_PUBLIC_KEY',
      required: true,
      label: 'Public key',
      secret: false,
      placeholder: 'Application public key (hex)',
    },
    { key: 'DISCORD_GUILD_ID', label: 'Default server ID', secret: false, placeholder: '123456789012345678' },
  ],
  slack: [
    { key: 'SLACK_BOT_TOKEN', required: true, label: 'Bot token', secret: true, placeholder: 'xoxb-…' },
    {
      key: 'SLACK_SIGNING_SECRET',
      required: true,
      label: 'Signing secret',
      secret: true,
      placeholder: 'Slack app signing secret',
    },
  ],
  telegram: [
    { key: 'TELEGRAM_BOT_TOKEN', required: true, label: 'Bot token', secret: true, placeholder: '123456789:…' },
    {
      key: 'TELEGRAM_WEBHOOK_SECRET',
      required: true,
      label: 'Webhook secret',
      secret: true,
      placeholder: 'Telegram webhook secret token',
    },
    { key: 'TELEGRAM_BOT_ID', label: 'Bot ID', secret: false, placeholder: '123456789' },
  ],
} as const
export type ChannelIntegrationKey = keyof typeof channelIntegrationFields
export function isChannelIntegration(key: string): key is ChannelIntegrationKey {
  return Object.hasOwn(channelIntegrationFields, key)
}
export function isChannelCredential(key: string): boolean {
  return Object.values(channelIntegrationFields).some((fields) => fields.some((field) => field.key === key))
}
export const channelIntegrationCatalog: SafeIntegrationCatalogEntry[] = (
  Object.keys(channelIntegrationFields) as ChannelIntegrationKey[]
).map((key) => ({
  manifestVersion: 1,
  key,
  adapterVersion: 1,
  label: key[0].toUpperCase() + key.slice(1),
  description: `Connect a ${key[0].toUpperCase() + key.slice(1)} bot, route conversations to squads, and deliver notifications.`,
  icon: key,
  connectionMode: 'channel',
  assignable: false,
  requiredCapabilities: [],
  sandbox: { packages: [], skills: [], extensions: [], protectedBindingNames: [] },
}))

export function getChannelIntegrationSettings(provider: string) {
  if (!isChannelIntegration(provider)) throw new Error('Unknown channel integration')
  return readIntegrationCredentialFields(channelIntegrationFields[provider])
}
export async function configureChannelIntegration(provider: string, input: unknown, actor: string) {
  if (!isChannelIntegration(provider)) throw new Error('Unknown channel integration')
  return writeIntegrationCredentialFields(channelIntegrationFields[provider], input, actor)
}

/** Transport compatibility boundary; enable state is managed by the integration. */
export function getChannelIntegrationValue(key: string): string | undefined {
  const provider = key.split('_', 1)[0].toLowerCase()
  if (getSettingsStore().getStoredValue(`__integration-enabled:${provider}`) === 'false') return undefined
  return getSecretStore().get(key)
}

/** Preserve configured channels on upgrade; fresh integrations remain disabled. */
export async function initializeChannelIntegrationStates() {
  const { db, settings } = await import('../../../db')
  for (const provider of Object.keys(channelIntegrationFields)) {
    const key = `__integration-enabled:${provider}`
    const token = getSecretStore().get(`${provider.toUpperCase()}_BOT_TOKEN`)
    await db
      .insert(settings)
      .values({ key, value: String(!!token) })
      .onConflictDoNothing()
    await getSettingsStore().refreshKey(key)
  }
}
