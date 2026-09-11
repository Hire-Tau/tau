import { inArray, eq } from 'drizzle-orm'
import { db, secrets, settings } from '../db'
import { PROVIDER_AUTH_DATA_KEY } from '../services/agent/account-store'
import { refreshModelRuntime } from '../services/agent/auth-backend'
import { OPENROUTER_TIER_EXPANSION_KEY } from '../services/model-selection/openrouter-settings'
import { providerHealth, resetProviderHealthForTests } from '../services/provider-health/registry'
import { getSecretStore, resetSecretStore } from '../services/secrets'
import { getSettingsStore, resetSettingsStore } from '../services/settings'
import {
  restoreProviderAuthEnv,
  snapshotAndClearProviderAuthEnv,
  type ProviderAuthEnvSnapshot,
} from './provider-auth-env'

const SELECTION_SETTING_KEYS = [OPENROUTER_TIER_EXPANSION_KEY, 'DISABLED_PROVIDERS']

export interface ProviderHealthTestSnapshot {
  map: Map<unknown, unknown>
  records: Map<unknown, unknown>
  revisions: Map<unknown, unknown>
  lastExhaustionRetryAt: Map<unknown, unknown>
  persistenceEnabled: boolean
}

export interface OpenRouterTestStateSnapshot {
  providerAuthEnv: ProviderAuthEnvSnapshot
  accountRow?: typeof secrets.$inferSelect
  settingRows: Array<typeof settings.$inferSelect>
  providerHealth: ProviderHealthTestSnapshot
}

export function snapshotProviderHealthTestState(): ProviderHealthTestSnapshot {
  const registry = providerHealth as any
  return {
    map: new Map(registry.map),
    records: new Map(registry.records),
    revisions: new Map(registry.revisions),
    lastExhaustionRetryAt: new Map(registry.lastExhaustionRetryAt),
    persistenceEnabled: registry.persistenceEnabled,
  }
}

export function restoreProviderHealthTestState(snapshot: ProviderHealthTestSnapshot): void {
  resetProviderHealthForTests()
  const registry = providerHealth as any
  registry.map = new Map(snapshot.map)
  registry.records = new Map(snapshot.records)
  registry.revisions = new Map(snapshot.revisions)
  registry.lastExhaustionRetryAt = new Map(snapshot.lastExhaustionRetryAt)
  registry.persistenceEnabled = snapshot.persistenceEnabled
}

/**
 * Snapshot and clear every ambient input used by OpenRouter route selection.
 * Rows are retained verbatim so even absence and encrypted account data can be
 * restored; singleton caches and ModelRuntime are rebuilt at the boundaries.
 */
export async function isolateOpenRouterTestState(): Promise<OpenRouterTestStateSnapshot> {
  const providerAuthEnv = snapshotAndClearProviderAuthEnv()
  const providerHealthSnapshot = snapshotProviderHealthTestState()
  const [accountRow] = await db.select().from(secrets).where(eq(secrets.key, PROVIDER_AUTH_DATA_KEY))
  const settingRows = await db.select().from(settings).where(inArray(settings.key, SELECTION_SETTING_KEYS))

  await db.delete(secrets).where(eq(secrets.key, PROVIDER_AUTH_DATA_KEY))
  resetSecretStore()
  await db.delete(settings).where(inArray(settings.key, SELECTION_SETTING_KEYS))
  resetSettingsStore()
  await getSettingsStore().initialize()
  resetProviderHealthForTests()
  await refreshModelRuntime()

  return {
    providerAuthEnv,
    providerHealth: providerHealthSnapshot,
    settingRows,
    ...(accountRow ? { accountRow } : {}),
  }
}

/** Restore rows, singleton caches, health, environment, and runtime to their prior state. */
export async function restoreOpenRouterTestState(snapshot: OpenRouterTestStateSnapshot): Promise<void> {
  await db.delete(secrets).where(eq(secrets.key, PROVIDER_AUTH_DATA_KEY))
  if (snapshot.accountRow) await db.insert(secrets).values(snapshot.accountRow)
  resetSecretStore()
  // A persisted account row necessarily came from an initialized encrypted
  // store, so rebuild that cache only when there is a row to restore. Provider
  // env remains cleared during initialization so it cannot be migrated to DB.
  if (snapshot.accountRow) await getSecretStore().initialize()
  restoreProviderAuthEnv(snapshot.providerAuthEnv)

  await db.delete(settings).where(inArray(settings.key, SELECTION_SETTING_KEYS))
  if (snapshot.settingRows.length > 0) await db.insert(settings).values(snapshot.settingRows)
  resetSettingsStore()
  await getSettingsStore().initialize()
  restoreProviderHealthTestState(snapshot.providerHealth)
  await refreshModelRuntime()
}
