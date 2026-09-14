import { describe, test, expect, beforeEach } from 'bun:test'
import { db, channelInstances } from '../../db'
import { ChannelSync } from './channel-sync'

describe('ChannelSync', () => {
  const sync = new ChannelSync()

  beforeEach(async () => {
    await db.delete(channelInstances)
  })

  test('private chat policy defaults on and preserves explicit false through YAML round trips', () => {
    const yaml = 'id: bot\nname: Bot\nprovider: telegram\nproviderConfig:\n  botId: "42"\ndefaultSquadId: squad\n'
    expect(sync.parse(yaml, 'bot.yaml').allowPrivateChats).toBe(true)
    const parsed = sync.parse(yaml + 'allowPrivateChats: false\n', 'bot.yaml')
    expect(sync.parse(sync.toYaml(sync.toRecord(parsed)), 'bot.yaml').allowPrivateChats).toBe(false)
    expect(() => sync.parse(yaml + 'allowPrivateChats: "false"\n', 'bot.yaml')).toThrow('must be a boolean')
  })

  test('loadFromDir skips all example-prefixed files', async () => {
    const parsed = await sync.loadFromDir()
    expect(parsed).toHaveLength(0)
  })

  test('sync with no real files works (0 synced, 0 deleted)', async () => {
    const result = await sync.sync()
    expect(result.synced).toBe(0)
    expect(result.deleted).toBe(0)
    expect(result.skipped).toBe(0)

    const rows = await db.select().from(channelInstances)
    expect(rows).toHaveLength(0)
  })
})
