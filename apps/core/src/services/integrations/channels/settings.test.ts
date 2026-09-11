import { afterEach, beforeEach, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { db, secrets, settings } from '../../../db'
import { getSecretStore, resetSecretStore } from '../../secrets'
import { getSettingsStore, resetSettingsStore } from '../../settings'
import {
  configureChannelIntegration,
  getChannelIntegrationSettings,
  getChannelIntegrationValue,
  initializeChannelIntegrationStates,
} from './settings'

const credentialKeys = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'DISCORD_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN']
const enabledKeys = ['slack', 'discord', 'telegram'].map((key) => `__integration-enabled:${key}`)
const priorEnv = new Map<string, string | undefined>()
let priorSecrets: (typeof secrets.$inferSelect)[] = []
let priorSettings: (typeof settings.$inferSelect)[] = []
beforeEach(async () => {
  for (const key of [...credentialKeys, 'TAU_ENCRYPTION_KEY', 'TAU_MANAGED', 'TAU_MANAGED_SECRET_KEYS']) {
    priorEnv.set(key, process.env[key])
    delete process.env[key]
  }
  process.env.TAU_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  priorSecrets = await db.select().from(secrets).where(inArray(secrets.key, credentialKeys))
  priorSettings = await db.select().from(settings).where(inArray(settings.key, enabledKeys))
  await db.delete(secrets).where(inArray(secrets.key, credentialKeys))
  await db.delete(settings).where(inArray(settings.key, enabledKeys))
  resetSecretStore()
  resetSettingsStore()
  await getSecretStore().initialize()
  await getSettingsStore().initialize()
})
afterEach(async () => {
  await db.delete(secrets).where(inArray(secrets.key, credentialKeys))
  await db.delete(settings).where(inArray(settings.key, enabledKeys))
  if (priorSecrets.length) await db.insert(secrets).values(priorSecrets)
  if (priorSettings.length) await db.insert(settings).values(priorSettings)
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetSecretStore()
  resetSettingsStore()
})

test('channel credentials are encrypted and redacted; only the selected provider fields can change', async () => {
  const result = await configureChannelIntegration(
    'slack',
    {
      SLACK_BOT_TOKEN: 'private-bot-token',
      SLACK_SIGNING_SECRET: 'private-signature',
    },
    'test'
  )
  expect(result.fields.every((field) => field.configured)).toBe(true)
  expect(JSON.stringify(result)).not.toContain('private-')
  expect(result.fields.every((field) => !('value' in field))).toBe(true)
  expect(JSON.stringify(await db.select().from(secrets).where(inArray(secrets.key, credentialKeys)))).not.toContain(
    'private-'
  )
  await expect(configureChannelIntegration('slack', { DISCORD_BOT_TOKEN: 'wrong-provider' }, 'test')).rejects.toThrow()
  expect(getChannelIntegrationSettings('discord').fields[0].configured).toBe(false)
  await expect(configureChannelIntegration('slack', { SLACK_SIGNING_SECRET: null }, 'test')).rejects.toThrow('required')
  expect(getChannelIntegrationSettings('slack').fields.map((field) => field.configured)).toEqual([true, true])
})

test('upgrades preserve configured bots, new integrations start disabled, and toggling retains credentials', async () => {
  await configureChannelIntegration('slack', { SLACK_BOT_TOKEN: 'retained-token' }, 'test')
  await initializeChannelIntegrationStates()
  expect(getSettingsStore().getStoredValue(enabledKeys[0])).toBe('true')
  expect(getSettingsStore().getStoredValue(enabledKeys[1])).toBe('false')
  expect(getChannelIntegrationValue('SLACK_BOT_TOKEN')).toBe('retained-token')
  await getSettingsStore().set(enabledKeys[0], 'false', 'test')
  expect(getChannelIntegrationValue('SLACK_BOT_TOKEN')).toBeUndefined()
  expect(getChannelIntegrationSettings('slack').fields[0].configured).toBe(true)
  await initializeChannelIntegrationStates()
  expect(getChannelIntegrationValue('SLACK_BOT_TOKEN')).toBeUndefined()
  await getSettingsStore().set(enabledKeys[0], 'true', 'test')
  expect(getChannelIntegrationValue('SLACK_BOT_TOKEN')).toBe('retained-token')
})

test('managed channel material remains hidden and cannot be replaced through the integration', async () => {
  process.env.TAU_MANAGED = '1'
  process.env.TAU_MANAGED_SECRET_KEYS = 'SLACK_BOT_TOKEN'
  process.env.SLACK_BOT_TOKEN = 'platform-only-token'
  const view = getChannelIntegrationSettings('slack')
  expect(view.fields[0]).toMatchObject({ managed: true, configured: true })
  expect(JSON.stringify(view)).not.toContain('platform-only-token')
  await expect(configureChannelIntegration('slack', { SLACK_BOT_TOKEN: 'replacement' }, 'test')).rejects.toThrow(
    'managed'
  )
  expect(getChannelIntegrationValue('SLACK_BOT_TOKEN')).toBe('platform-only-token')
})
