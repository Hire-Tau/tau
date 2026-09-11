import { describe, expect, it } from 'bun:test'
import { Squad } from './Squad'
import { SquadSourceConfig } from './SquadSourceConfig'

describe('SquadSourceConfig', () => {
  it('upserts and finds a per-squad source config', async () => {
    const squad = await Squad.create({ name: 'Policy squad', purpose: 'test' })

    const created = await SquadSourceConfig.upsert({
      squadId: squad.id,
      sourceType: 'memory_file',
      enabled: false,
      policy: { version: 1, retentionDays: 30 },
    })

    expect(created.enabled).toBe(false)
    expect(created.policy).toEqual({ version: 1, retentionDays: 30 })

    const updated = await SquadSourceConfig.upsert({
      squadId: squad.id,
      sourceType: 'memory_file',
      enabled: true,
      policy: { version: 1, timeWindowDays: 7 },
    })

    expect(updated.id).toBe(created.id)
    expect(updated.enabled).toBe(true)

    const found = await SquadSourceConfig.findBySquadAndType(squad.id, 'memory_file')
    expect(found?.policy).toEqual({ version: 1, timeWindowDays: 7 })
  })

  it('preserves existing enabled state on policy-only update', async () => {
    const squad = await Squad.create({ name: 'Preserve enabled squad', purpose: 'test' })
    const disabled = await SquadSourceConfig.upsert({
      squadId: squad.id,
      sourceType: 'memory_file',
      enabled: false,
      policy: { version: 1 },
    })
    expect(disabled.enabled).toBe(false)

    const updated = await SquadSourceConfig.upsert({
      squadId: squad.id,
      sourceType: 'memory_file',
      policy: { version: 1, retentionDays: 10 },
    })

    expect(updated.enabled).toBe(false)
    expect(updated.policy).toEqual({ version: 1, retentionDays: 10 })
  })

  it('lists configs by squad', async () => {
    const squad = await Squad.create({ name: 'List policy squad', purpose: 'test' })
    await SquadSourceConfig.upsert({ squadId: squad.id, sourceType: 'memory_file', policy: { version: 1 } })
    await SquadSourceConfig.upsert({ squadId: squad.id, sourceType: 'agent_thread', policy: { version: 1 } })

    const configs = await SquadSourceConfig.listBySquad(squad.id)

    expect(configs.map((config) => config.sourceType).sort()).toEqual(['agent_thread', 'memory_file'])
  })
})
