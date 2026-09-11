import { describe, expect, test } from 'bun:test'
import {
  PROVIDERS,
  getProviderMeta,
  generateChannelId,
  buildProviderConfig,
  extractProviderConfigValue,
  mapToOverrideRows,
  overrideRowsToMap,
} from './channelFormHelpers'

describe('PROVIDERS', () => {
  test('exposes capitalized display names for discord, slack, telegram', () => {
    const labels = PROVIDERS.map((p) => p.label)
    expect(labels).toEqual(['Discord', 'Slack', 'Telegram'])
  })

  test('each provider has an honest config field label distinct from the raw key', () => {
    const discord = getProviderMeta('discord')
    expect(discord.configField.label).toBe('Discord server ID')
    expect(discord.configField.hint.length).toBeGreaterThan(0)
    const slack = getProviderMeta('slack')
    expect(slack.configField.label).toBe('Slack workspace ID')
    const telegram = getProviderMeta('telegram')
    expect(telegram.configField.label).toBe('Telegram bot ID')
  })
})

describe('generateChannelId', () => {
  test('produces <provider>-<6 hex chars>', () => {
    const id = generateChannelId('discord')
    expect(id).toMatch(/^discord-[0-9a-f]{6}$/)
  })

  test('is different across calls (random)', () => {
    const a = generateChannelId('slack')
    const b = generateChannelId('slack')
    expect(a).not.toBe(b)
  })

  test('stays within the backend varchar(100) limit', () => {
    const id = generateChannelId('telegram')
    expect(id.length).toBeLessThanOrEqual(100)
  })
})

describe('buildProviderConfig / extractProviderConfigValue', () => {
  test('discord round-trips through guildId', () => {
    const config = buildProviderConfig('discord', '123')
    expect(config).toEqual({ guildId: '123' })
    expect(extractProviderConfigValue('discord', config)).toBe('123')
  })

  test('slack round-trips through teamId', () => {
    const config = buildProviderConfig('slack', 'T0123')
    expect(config).toEqual({ teamId: 'T0123' })
    expect(extractProviderConfigValue('slack', config)).toBe('T0123')
  })

  test('telegram round-trips through botId', () => {
    const config = buildProviderConfig('telegram', '999')
    expect(config).toEqual({ botId: '999' })
    expect(extractProviderConfigValue('telegram', config)).toBe('999')
  })

  test('extract returns empty string for missing/null config', () => {
    expect(extractProviderConfigValue('discord', null)).toBe('')
    expect(extractProviderConfigValue('discord', {})).toBe('')
  })
})

describe('mapToOverrideRows / overrideRowsToMap', () => {
  test('round-trips a hand-written map into rows and back to the same map shape', () => {
    const map = { 'chan-1': 'squad-a', 'chan-2': 'squad-b' }
    const rows = mapToOverrideRows(map)
    expect(rows).toEqual([
      { key: 'chan-1', squadId: 'squad-a' },
      { key: 'chan-2', squadId: 'squad-b' },
    ])
    expect(overrideRowsToMap(rows)).toEqual(map)
  })

  test('empty/undefined map produces no rows', () => {
    expect(mapToOverrideRows(undefined)).toEqual([])
    expect(mapToOverrideRows(null)).toEqual([])
    expect(mapToOverrideRows({})).toEqual([])
  })

  test('strips fully-empty rows when serializing (both fields blank)', () => {
    const rows = [
      { key: '', squadId: '' },
      { key: 'chan-1', squadId: 'squad-a' },
    ]
    expect(overrideRowsToMap(rows)).toEqual({ 'chan-1': 'squad-a' })
  })

  test('a non-string map value is coerced, not dropped, when converting to rows', () => {
    const rows = mapToOverrideRows({ 'chan-1': 42 as unknown as string })
    expect(rows).toEqual([{ key: 'chan-1', squadId: '42' }])
  })

  test('trims whitespace on serialize', () => {
    const rows = [{ key: '  chan-1  ', squadId: '  squad-a  ' }]
    expect(overrideRowsToMap(rows)).toEqual({ 'chan-1': 'squad-a' })
  })

  test('trims whitespace on load, so an untouched resave of a whitespace-carrying stored map is byte-identical to the loaded (trimmed) form', () => {
    const storedMap = { ' chan-1': 'squad-a ' }
    const rows = mapToOverrideRows(storedMap)
    expect(rows).toEqual([{ key: 'chan-1', squadId: 'squad-a' }])
    expect(overrideRowsToMap(rows)).toEqual({ 'chan-1': 'squad-a' })
  })

  test('load normalizes once: reloading the resaved map produces the same rows again (resave is stable)', () => {
    const storedMap = { ' chan-1': 'squad-a ' }
    const firstLoadRows = mapToOverrideRows(storedMap)
    const resavedMap = overrideRowsToMap(firstLoadRows)
    const secondLoadRows = mapToOverrideRows(resavedMap)
    expect(secondLoadRows).toEqual(firstLoadRows)
    expect(overrideRowsToMap(secondLoadRows)).toEqual(resavedMap)
  })
})
