import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHANNELS_DIR } from '../../../lib/paths'
import { getSecretStore } from '../../secrets'
import { getSettingsStore } from '../../settings'
import { channelConnections, enabledSettingKey, isLegacyChannelCredentialKey } from './connections'
import { channelProviderKeys, isChannelProviderKey, type ChannelProviderKey } from './plugins'

export { type ChannelSettingsView } from './connections'

export const isChannelIntegration = isChannelProviderKey
/** Legacy secret-store keys the channel transports used before connections; still protected in the secrets UI. */
export const isChannelCredential = isLegacyChannelCredentialKey

/**
 * Transport compatibility boundary. The chat transports were written against
 * named secret keys; each key now resolves to a field of the provider's
 * connection (with the pre-connection secret keys as the fallback), so the
 * transports read through the connection without knowing its shape. Undefined
 * whenever the provider is switched off or has nothing usable.
 */
export function getChannelIntegrationValue(key: string): string | undefined {
  switch (key) {
    case 'TELEGRAM_BOT_TOKEN':
      return channelConnections.get('telegram')?.credential.botToken
    case 'TELEGRAM_WEBHOOK_SECRET':
      return channelConnections.get('telegram')?.credential.webhookSecret
    case 'TELEGRAM_BOT_ID':
      return channelConnections.get('telegram')?.configuration.botId
    case 'SLACK_BOT_TOKEN':
      return channelConnections.get('slack')?.credential.botToken
    case 'SLACK_SIGNING_SECRET':
      return channelConnections.get('slack')?.credential.signingSecret
    case 'DISCORD_BOT_TOKEN':
      return channelConnections.get('discord')?.credential.botToken
    case 'DISCORD_APPLICATION_ID':
      return channelConnections.get('discord')?.configuration.applicationId
    case 'DISCORD_PUBLIC_KEY':
      return channelConnections.get('discord')?.configuration.publicKey
    case 'DISCORD_GUILD_ID':
      return channelConnections.get('discord')?.configuration.guildId
    default:
      return undefined
  }
}

export const getChannelIntegrationSettings = (provider: string) => {
  if (!isChannelProviderKey(provider)) throw new Error('Unknown channel integration')
  return channelConnections.view(provider)
}

export const configureChannelIntegration = (provider: string, input: unknown, actor: string) => {
  if (!isChannelProviderKey(provider)) throw new Error('Unknown channel integration')
  return channelConnections.configure(provider, input, actor)
}

/** The Slack app manifest with this instance's URLs filled in. */
export function slackAppManifest(
  origin = channelConnections.webhookUrl('slack').replace(/\/api\/webhooks\/channels\/slack$/, '')
): string {
  const template = readFileSync(join(CHANNELS_DIR, 'slack-app-manifest.example.yaml'), 'utf8')
  const host = origin.replace(/^https?:\/\//, '')
  return template.replaceAll('https://YOUR_DOMAIN', origin).replaceAll('YOUR_DOMAIN', host)
}

/**
 * Boot: keep the provider switches consistent (configured bots stay on,
 * fresh ones start off), turn pre-connection secret keys into connections,
 * and take the first snapshot the transports read from.
 */
export async function initializeChannelIntegrationStates() {
  const { db, settings } = await import('../../../db')
  for (const provider of channelProviderKeys) {
    const key = enabledSettingKey(provider)
    const token = getSecretStore().get(`${provider.toUpperCase()}_BOT_TOKEN`)
    await db
      .insert(settings)
      .values({ key, value: String(!!token) })
      .onConflictDoNothing()
    await getSettingsStore().refreshKey(key)
  }
  await channelConnections.migrateLegacy()
  await channelConnections.refresh()
}

export const channelEnabledSettingKeys: readonly string[] = channelProviderKeys.map(enabledSettingKey)
export const isChannelEnabledSettingKey = (key: string): key is `__integration-enabled:${ChannelProviderKey}` =>
  channelEnabledSettingKeys.includes(key)
