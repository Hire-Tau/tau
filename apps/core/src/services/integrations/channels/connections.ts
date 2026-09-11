import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { createLogger } from '../../../lib/infra/logger'
import { primaryWebOrigin } from '../../auth/web-origins'
import { getSecretStore, isManagedSecretKey } from '../../secrets'
import { getSettingsStore } from '../../settings'
import { IntegrationConnectionService, IntegrationConnectionCreateCommittedError } from '../connection-service'
import type {
  IntegrationAssignmentRepository,
  IntegrationConnectionRecord,
  IntegrationConnectionRepository,
} from '../connection-repository'
import { DbIntegrationConnectionRepository } from '../db-connection-repository'
import { DbIntegrationAuditRecorder } from '../db-audit'
import type { IntegrationSetupStatus } from '../plugin'
import { credentialSetupStatus } from '../setup-status'
import {
  channelPlugins,
  createChannelPlugins,
  isChannelProviderKey,
  type ChannelPlugin,
  type ChannelProviderKey,
} from './plugins'

const log = createLogger('channel-connections')

// ChannelInstance pulls in the channel transports, which read this module's
// snapshot: loaded on use so neither side sees the other half-initialized.
const channelInstances = () => import('../../../entities/ChannelInstance')

// ── Legacy keys ──────────────────────────────────────────────────────────
// Before connections, each provider's material lived in these secret-store
// keys. They remain readable for one release: as the migration source, as the
// fallback while a migrated connection cannot authenticate, and as the only
// path for platform-managed keys (which the instance may not rewrite).

const legacyKeys = {
  telegram: {
    credential: { botToken: 'TELEGRAM_BOT_TOKEN', webhookSecret: 'TELEGRAM_WEBHOOK_SECRET' },
    configuration: { botId: 'TELEGRAM_BOT_ID' },
  },
  slack: {
    credential: { botToken: 'SLACK_BOT_TOKEN', signingSecret: 'SLACK_SIGNING_SECRET' },
    configuration: {},
  },
  discord: {
    credential: { botToken: 'DISCORD_BOT_TOKEN' },
    configuration: {
      applicationId: 'DISCORD_APPLICATION_ID',
      publicKey: 'DISCORD_PUBLIC_KEY',
      guildId: 'DISCORD_GUILD_ID',
    },
  },
} as const

export const legacyChannelCredentialKeys: readonly string[] = Object.values(legacyKeys).flatMap((keys) => [
  ...Object.values(keys.credential),
  ...Object.values(keys.configuration),
])
export const isLegacyChannelCredentialKey = (key: string) => legacyChannelCredentialKeys.includes(key)

export const enabledSettingKey = (provider: ChannelProviderKey) => `__integration-enabled:${provider}`

// ── State ────────────────────────────────────────────────────────────────

type PluginOf<K extends ChannelProviderKey> = (typeof channelPlugins)[K]
type ConfigurationOf<K extends ChannelProviderKey> = ReturnType<PluginOf<K>['connection']['parseConfiguration']>
type CredentialOf<K extends ChannelProviderKey> = ReturnType<PluginOf<K>['connection']['credential']['parse']>

export interface ChannelConnectionState<K extends ChannelProviderKey = ChannelProviderKey> {
  provider: K
  /** Connection row id, or `legacy:<provider>` when served from the old secret keys. */
  id: string
  /** Changes whenever the material changes; lifecycle hooks key their side effects on it. */
  revision: string
  source: 'connection' | 'legacy'
  connectionEnabled: boolean
  authState: IntegrationConnectionRecord['authState'] | 'legacy'
  healthState: IntegrationConnectionRecord['healthState'] | 'legacy'
  lastErrorCode: string | null
  configuration: ConfigurationOf<K>
  credential: CredentialOf<K>
}

/** The routing key each provider's channel instances are looked up by. */
export const channelRoutingKey = { telegram: 'botId', slack: 'teamId', discord: 'guildId' } as const

export interface ChannelSettingsView {
  provider: ChannelProviderKey
  fields: {
    key: string
    label: string
    placeholder: string
    required: boolean
    secret: true
    configured: boolean
    managed: boolean
  }[]
  /** Discovered by the provider after the credential validated; never typed by the user. */
  identity: Record<string, string> | null
  connection: {
    id: string
    source: 'connection' | 'legacy'
    authState: string
    healthState: string
    lastErrorCode: string | null
  } | null
  /** Whether the provider switch is on; credentials are retained while off. */
  enabled: boolean
  setup: IntegrationSetupStatus
  webhook: { url: string; secretConfigured: boolean }
  routing: { instanceId: string; defaultSquadId: string | null } | null
  /** Discord only: servers the bot is in; routing needs exactly one, or a chosen `guildId`. */
  guilds?: { id: string; name: string }[]
}

type ChannelConnectionRepository = IntegrationConnectionRepository & Pick<IntegrationAssignmentRepository, 'usage'>

export interface ChannelConnectionsDependencies {
  plugins?: typeof channelPlugins
  repository?: ChannelConnectionRepository
  fetch?: typeof fetch
  now?: () => Date
  webOrigin?: () => string
  randomSecret?: () => string
}

const configureInputSchema = z
  .object({
    botToken: z.string().max(4096).nullable().optional(),
    signingSecret: z.string().max(4096).nullable().optional(),
    guildId: z.string().trim().max(64).nullable().optional(),
    defaultSquadId: z.string().uuid().nullable().optional(),
  })
  .strict()
export type ConfigureChannelInput = z.infer<typeof configureInputSchema>

type Listener = (states: ReadonlyMap<ChannelProviderKey, ChannelConnectionState | undefined>) => void | Promise<void>

/**
 * One connection per channel provider, read by the chat transports through
 * an in-memory snapshot so their synchronous call sites keep working. The
 * snapshot is refreshed after every local write and on a timer in each
 * process; lifecycle listeners (webhook registration, slash commands, the
 * Discord gateway) react to revision changes.
 */
export class ChannelConnections {
  readonly #plugins: typeof channelPlugins
  readonly #repository: ChannelConnectionRepository
  readonly #fetch: typeof fetch
  readonly #now: () => Date
  readonly #webOrigin: () => string
  readonly #randomSecret: () => string
  readonly #service: IntegrationConnectionService
  readonly #snapshot = new Map<ChannelProviderKey, ChannelConnectionState | undefined>()
  readonly #listeners = new Set<Listener>()
  #loaded = false

  constructor(dependencies: ChannelConnectionsDependencies = {}) {
    this.#plugins = dependencies.plugins ?? channelPlugins
    this.#repository = dependencies.repository ?? new DbIntegrationConnectionRepository()
    this.#fetch = dependencies.fetch ?? fetch
    this.#now = dependencies.now ?? (() => new Date())
    this.#webOrigin = dependencies.webOrigin ?? primaryWebOrigin
    this.#randomSecret = dependencies.randomSecret ?? (() => randomBytes(32).toString('hex'))
    this.#service = new IntegrationConnectionService({
      repository: this.#repository,
      assignments: this.#repository,
      credentials: {
        get: (key) => getSecretStore().get(key),
        set: (key, value, actor) => getSecretStore().set(key, value, actor),
        delete: (key) => getSecretStore().delete(key),
      },
      resolveProvider: (key) => {
        if (!isChannelProviderKey(key)) throw new Error(`Unknown channel provider: ${key}`)
        return this.#plugins[key].runtime.provider
      },
      audit: new DbIntegrationAuditRecorder(),
      now: this.#now,
    })
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  /** Public webhook/interactions URL for a provider on this instance. */
  webhookUrl(provider: ChannelProviderKey): string {
    return `${this.#webOrigin()}/api/webhooks/channels/${provider}`
  }

  /** Whether the provider switch is on. Off means "keep the material, stop the transport". */
  isEnabled(provider: ChannelProviderKey): boolean {
    return getSettingsStore().getStoredValue(enabledSettingKey(provider)) !== 'false'
  }

  /**
   * The connection a transport should use right now, or undefined when the
   * provider is switched off or nothing usable is configured. Synchronous:
   * served from the last refresh, with the legacy keys as the fallback.
   */
  get<K extends ChannelProviderKey>(provider: K): ChannelConnectionState<K> | undefined {
    if (!this.isEnabled(provider)) return undefined
    const state = this.#snapshot.get(provider) as ChannelConnectionState<K> | undefined
    if (state && state.source === 'connection' && state.connectionEnabled && state.authState === 'authenticated')
      return state
    return this.#legacy(provider)
  }

  /** The stored connection regardless of usability — what the settings card shows. */
  stored<K extends ChannelProviderKey>(provider: K): ChannelConnectionState<K> | undefined {
    return (this.#snapshot.get(provider) as ChannelConnectionState<K> | undefined) ?? this.#legacy(provider)
  }

  /**
   * The pre-connection material as the transports always saw it: whatever
   * keys are set, possibly incomplete (a bot token without its signing
   * secret still posts messages). Migration is stricter and uses the codec.
   */
  #legacy<K extends ChannelProviderKey>(provider: K): ChannelConnectionState<K> | undefined {
    const keys = legacyKeys[provider]
    const store = getSecretStore()
    const credential: Record<string, string> = {}
    for (const [field, key] of Object.entries(keys.credential)) {
      const value = store.get(key)?.trim()
      if (value) credential[field] = value
    }
    if (!credential.botToken) return undefined
    const credentialValue = credential as CredentialOf<K>
    const configuration: Record<string, string> = {}
    for (const [field, key] of Object.entries(keys.configuration)) {
      const value = store.get(key)?.trim()
      if (value) configuration[field] = value
    }
    return {
      provider,
      id: `legacy:${provider}`,
      // A hash, not the secrets: a rotated token of the same length is still a new revision.
      revision: `legacy:${Bun.hash(JSON.stringify([credential, configuration])).toString(36)}`,
      source: 'legacy',
      connectionEnabled: true,
      authState: 'legacy',
      healthState: 'legacy',
      lastErrorCode: null,
      configuration: this.#plugins[provider].connection.parseConfiguration({
        version: 1,
        ...configuration,
      }) as ConfigurationOf<K>,
      credential: credentialValue,
    }
  }

  /** Is any of this provider's legacy material platform-managed (and therefore not ours to migrate or edit)? */
  #managed(provider: ChannelProviderKey): boolean {
    return [
      ...Object.values(legacyKeys[provider].credential),
      ...Object.values(legacyKeys[provider].configuration),
    ].some(isManagedSecretKey)
  }

  // ── Snapshot ───────────────────────────────────────────────────────────

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async refresh(): Promise<void> {
    for (const provider of Object.keys(this.#plugins) as ChannelProviderKey[]) {
      this.#snapshot.set(provider, await this.#load(provider))
    }
    this.#loaded = true
    for (const listener of this.#listeners) {
      try {
        await listener(this.#snapshot)
      } catch (error) {
        log.warn(`Channel connection listener failed: ${String(error)}`)
      }
    }
  }

  get loaded(): boolean {
    return this.#loaded
  }

  async #row(provider: ChannelProviderKey): Promise<IntegrationConnectionRecord | undefined> {
    const rows = (await this.#repository.list(provider)).filter(
      (row) => row.adapterVersion === 1 && row.clientAuthority === 'local'
    )
    // Newest wins if an interrupted save ever left two behind.
    return rows.sort((a, b) => b.materialRevision.localeCompare(a.materialRevision))[0]
  }

  async #load<K extends ChannelProviderKey>(provider: K): Promise<ChannelConnectionState<K> | undefined> {
    const row = await this.#row(provider)
    if (!row) return undefined
    const plugin = this.#plugins[provider] as ChannelPlugin<unknown, unknown, unknown>
    const raw = getSecretStore().get(row.credentialRef)
    if (!raw) return undefined
    try {
      return {
        provider,
        id: row.id,
        revision: row.materialRevision,
        source: 'connection',
        connectionEnabled: row.enabled,
        authState: row.authState,
        healthState: row.healthState,
        lastErrorCode: row.lastErrorCode,
        configuration: plugin.connection.parseConfiguration(row.configuration) as ConfigurationOf<K>,
        credential: plugin.connection.credential.parse(raw) as CredentialOf<K>,
      }
    } catch (error) {
      log.warn(`Stored ${provider} connection ${row.id} is unreadable: ${String(error)}`)
      return undefined
    }
  }

  // ── Settings card ──────────────────────────────────────────────────────

  async view(provider: ChannelProviderKey): Promise<ChannelSettingsView> {
    if (!this.#loaded) await this.refresh()
    const plugin = this.#plugins[provider] as ChannelPlugin<Record<string, unknown>, Record<string, unknown>, unknown>
    const stored = this.stored(provider) as ChannelConnectionState | undefined
    const managed = this.#managed(provider)
    const fields = plugin.channel.credentialFields.map((field) => ({
      ...field,
      configured: !!(stored?.credential as Record<string, unknown> | undefined)?.[field.key],
      managed,
    }))
    const configuration = (stored?.configuration ?? {}) as Record<string, unknown>
    const identity = Object.fromEntries(
      Object.entries(configuration).filter(([key, value]) => key !== 'version' && typeof value === 'string')
    ) as Record<string, string>
    const routing = await this.#routing(provider, stored)
    const view: ChannelSettingsView = {
      provider,
      fields,
      identity: Object.keys(identity).length ? identity : null,
      connection: stored
        ? {
            id: stored.id,
            source: stored.source,
            authState: stored.authState,
            healthState: stored.healthState,
            lastErrorCode: stored.lastErrorCode,
          }
        : null,
      enabled: this.isEnabled(provider),
      setup: this.#setup(provider, fields, stored),
      webhook: {
        url: this.webhookUrl(provider),
        secretConfigured:
          provider === 'telegram'
            ? !!(stored?.credential as { webhookSecret?: string } | undefined)?.webhookSecret
            : provider === 'slack'
              ? !!(stored?.credential as { signingSecret?: string } | undefined)?.signingSecret
              : !!identity.publicKey,
      },
      routing: routing ? { instanceId: routing.id, defaultSquadId: routing.defaultSquadId } : null,
    }
    if (provider === 'discord' && stored)
      view.guilds = await this.#discordGuilds(stored as ChannelConnectionState<'discord'>)
    return view
  }

  #setup(
    provider: ChannelProviderKey,
    fields: ChannelSettingsView['fields'],
    stored: ChannelConnectionState | undefined
  ): IntegrationSetupStatus {
    const status = credentialSetupStatus(fields)
    if (status.state !== 'configured' || !stored || stored.source !== 'connection') return status
    if (stored.authState !== 'authenticated')
      return {
        state: 'needs_attention',
        issues: [
          `${this.#plugins[provider].presentation.label} rejected the saved credential${stored.lastErrorCode ? ` (${stored.lastErrorCode})` : ''}.`,
        ],
      }
    return status
  }

  async #routing(provider: ChannelProviderKey, stored: ChannelConnectionState | undefined) {
    const key = channelRoutingKey[provider]
    const identifier = (stored?.configuration as Record<string, unknown> | undefined)?.[key]
    if (typeof identifier !== 'string' || !identifier) return null
    const { ChannelInstance } = await channelInstances()
    return ChannelInstance.findByProvider(provider, identifier)
  }

  async #discordGuilds(state: ChannelConnectionState<'discord'>): Promise<{ id: string; name: string }[]> {
    try {
      const response = await this.#fetch('https://discord.com/api/v10/users/@me/guilds', {
        headers: { authorization: `Bot ${state.credential.botToken}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) return []
      const body = (await response.json()) as { id?: string; name?: string }[]
      return body.filter((guild) => guild.id && guild.name).map((guild) => ({ id: guild.id!, name: guild.name! }))
    } catch {
      return []
    }
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  /**
   * Save credentials and/or routing for a provider. Credentials are validated
   * against the provider before they replace the stored connection, and the
   * provider's own identity is recorded on it. Partial input is fine: only
   * the given fields change.
   */
  async configure(provider: ChannelProviderKey, rawInput: unknown, actor: string): Promise<ChannelSettingsView> {
    const input = configureInputSchema.parse(rawInput)
    if (!this.#loaded) await this.refresh()
    if (this.#managed(provider)) throw new Error('This credential is managed by your platform.')
    const plugin = this.#plugins[provider] as ChannelPlugin<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, string>
    >
    const stored = this.stored(provider) as ChannelConnectionState | undefined

    const credentialInput: Record<string, unknown> = { ...(stored?.credential as Record<string, unknown> | undefined) }
    let credentialChanged = false
    for (const field of plugin.channel.credentialFields) {
      if (!Object.hasOwn(input, field.key)) continue
      const value = (input as Record<string, string | null | undefined>)[field.key]
      if (!value?.trim()) throw new Error(`${field.label} is required.`)
      if (credentialInput[field.key] !== value.trim()) credentialChanged = true
      credentialInput[field.key] = value.trim()
    }
    if (provider === 'telegram' && credentialInput.botToken && !credentialInput.webhookSecret) {
      // Generated here, registered with Telegram by the lifecycle hook: the
      // user never sees or types it.
      credentialInput.webhookSecret = this.#randomSecret()
      credentialChanged = true
    }

    const configurationInput: Record<string, unknown> = {
      ...(stored?.configuration as Record<string, unknown> | undefined),
    }
    let configurationChanged = false
    if (provider === 'discord' && Object.hasOwn(input, 'guildId')) {
      const guildId = input.guildId?.trim() || undefined
      if (configurationInput.guildId !== guildId) configurationChanged = true
      if (guildId) configurationInput.guildId = guildId
      else delete configurationInput.guildId
    }

    const needsConnection = stored?.source !== 'connection' || credentialChanged || configurationChanged
    if (needsConnection && !Object.keys(credentialInput).length) {
      throw new Error(`${plugin.channel.credentialFields[0]!.label} is required.`)
    }
    if (needsConnection) {
      const credential = plugin.connection.credential.parse(credentialInput)
      let identity: Record<string, string> = {}
      try {
        identity = await plugin.channel.identity(credential)
      } catch (error) {
        log.warn(`${provider} identity discovery failed; the connection will validate and retry: ${String(error)}`)
      }
      const configuration = plugin.connection.parseConfiguration({ ...configurationInput, ...identity, version: 1 })
      await this.#replaceConnection(provider, { configuration, credential }, actor)
      await this.refresh()
    }

    if (Object.hasOwn(input, 'defaultSquadId')) {
      await this.#setDefaultSquad(provider, input.defaultSquadId ?? null)
    }
    return this.view(provider)
  }

  async #replaceConnection(
    provider: ChannelProviderKey,
    material: { configuration: unknown; credential: unknown },
    actor: string
  ): Promise<void> {
    const plugin = this.#plugins[provider] as ChannelPlugin<unknown, unknown, unknown>
    const previous = await this.#row(provider)
    let createdId: string | undefined
    try {
      createdId = (
        await this.#service.create({
          providerKey: provider,
          adapterVersion: 1,
          displayName: plugin.presentation.label,
          configuration: material.configuration,
          credential: plugin.connection.credential.serialize(material.credential),
          actor,
        })
      ).id
    } catch (error) {
      // The row exists but the provider rejected or could not be reached; the
      // card shows that, and the transports keep using whatever worked before.
      if (!(error instanceof IntegrationConnectionCreateCommittedError)) throw error
      log.warn(`${provider} connection saved but not validated: ${String(error.cause)}`)
    }
    if (createdId) {
      // A connection is created disabled; enabling re-validates and flips it on.
      try {
        await this.#service.enable(createdId, actor)
      } catch (error) {
        log.warn(`${provider} connection saved but could not be enabled: ${String(error)}`)
      }
    }
    if (previous) {
      try {
        await this.#service.remove(previous.id, actor)
      } catch (error) {
        log.warn(`Could not retire the previous ${provider} connection ${previous.id}: ${String(error)}`)
      }
    }
  }

  async #setDefaultSquad(provider: ChannelProviderKey, defaultSquadId: string | null): Promise<void> {
    const stored = this.stored(provider)
    const key = channelRoutingKey[provider]
    const identifier = (stored?.configuration as Record<string, unknown> | undefined)?.[key]
    if (typeof identifier !== 'string' || !identifier) {
      if (provider === 'discord')
        throw new Error('Choose the Discord server first: the bot is in several servers, or none yet.')
      throw new Error('Save a valid credential before choosing a default squad.')
    }
    const { ChannelInstance } = await channelInstances()
    const existing = await ChannelInstance.findByProvider(provider, identifier)
    if (existing) {
      await existing.update({ defaultSquadId })
      return
    }
    if (!defaultSquadId) return
    const label = this.#plugins[provider].presentation.label
    const identity = (stored?.configuration ?? {}) as Record<string, unknown>
    const displayName =
      typeof identity.teamName === 'string'
        ? identity.teamName
        : typeof identity.username === 'string'
          ? `@${identity.username}`
          : identifier
    await ChannelInstance.create({
      id: `${provider}-${identifier}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .slice(0, 100),
      name: `${label} · ${displayName}`,
      provider,
      providerConfig: { [key]: identifier },
      defaultSquadId,
    })
  }

  /**
   * Turn legacy secret keys into connections, once, for installs that
   * configured a bot before connections existed. Managed keys are left alone;
   * a connection that fails validation still exists and the card explains why.
   */
  async migrateLegacy(actor = 'system'): Promise<ChannelProviderKey[]> {
    const migrated: ChannelProviderKey[] = []
    for (const provider of Object.keys(this.#plugins) as ChannelProviderKey[]) {
      if (this.#managed(provider)) continue
      const legacy = this.#legacy(provider)
      if (!legacy) continue
      if (await this.#row(provider)) continue
      const plugin = this.#plugins[provider] as ChannelPlugin<
        Record<string, unknown>,
        Record<string, unknown>,
        Record<string, string>
      >
      try {
        plugin.connection.credential.parse(legacy.credential)
      } catch {
        log.warn(`${provider} legacy credentials are incomplete; not migrating them (the transport still uses them)`)
        continue
      }
      let identity: Record<string, string> = {}
      try {
        identity = await plugin.channel.identity(legacy.credential as Record<string, unknown>)
      } catch {
        // Offline at boot: the configured identity (if any) carries over as is.
      }
      const configuration = plugin.connection.parseConfiguration({
        ...(legacy.configuration as Record<string, unknown>),
        ...identity,
        version: 1,
      })
      await this.#replaceConnection(provider, { configuration, credential: legacy.credential }, actor)
      migrated.push(provider)
      log.info(`Migrated ${provider} credentials into an integration connection`)
    }
    if (migrated.length) await this.refresh()
    return migrated
  }

  /** Discovery for Discord routing when the bot is in exactly one server. */
  async discoverDiscordGuild(): Promise<string | undefined> {
    const state = this.stored('discord')
    if (!state) return undefined
    if (state.configuration.guildId) return state.configuration.guildId
    const guilds = await this.#discordGuilds(state)
    return guilds.length === 1 ? guilds[0]!.id : undefined
  }
}

export const channelConnections = new ChannelConnections()

/** Test seam: a ChannelConnections wired to fake provider APIs. */
export const createChannelConnections = (dependencies: ChannelConnectionsDependencies & { fetch: typeof fetch }) =>
  new ChannelConnections({
    ...dependencies,
    plugins: dependencies.plugins ?? createChannelPlugins({ fetch: dependencies.fetch }),
  })
