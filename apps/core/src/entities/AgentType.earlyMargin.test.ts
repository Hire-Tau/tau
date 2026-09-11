import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, agentTypes } from '../db'
import { AgentType, type AgentTypeRow } from './AgentType'

function makeRow(overrides: Partial<AgentTypeRow> = {}): AgentTypeRow {
  return {
    id: 'test-agent-type',
    name: 'Test Agent Type',
    model: 'anthropic:claude-sonnet-4-6',
    description: null,
    systemPrompt: 'You are a test agent.',
    skills: null,
    extensions: null,
    toolsAllow: null,
    toolsDeny: null,
    earlyMarginTokens: null,
    inFlightMarginTokens: null,
    yamlTemplate: null,
    yamlFieldOverrides: [],
    disabled: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as AgentTypeRow
}

describe('AgentType margin token fields', () => {
  beforeEach(async () => {
    await db.delete(agentTypes)
    AgentType.invalidateCache()
  })

  test('exposes the columns on the entity', () => {
    const type = new AgentType(makeRow({ earlyMarginTokens: 30000, inFlightMarginTokens: 8192 }))

    expect(type.earlyMarginTokens).toBe(30000)
    expect(type.inFlightMarginTokens).toBe(8192)
  })

  test('serializes margin token fields in toJson', () => {
    const type = new AgentType(makeRow({ earlyMarginTokens: 30000, inFlightMarginTokens: 8192 }))

    expect(type.toJson().earlyMarginTokens).toBe(30000)
    expect(type.toJson().inFlightMarginTokens).toBe(8192)
  })

  test('defaults to null when unset', () => {
    const type = new AgentType(makeRow())

    expect(type.toJson().earlyMarginTokens).toBeNull()
    expect(type.toJson().inFlightMarginTokens).toBeNull()
  })

  test('create persists earlyMarginTokens', async () => {
    const type = await AgentType.create({
      id: 'create-margin-test',
      name: 'Create Margin Test',
      model: 'anthropic:claude-sonnet-4-6',
      systemPrompt: 'You are a test agent.',
      earlyMarginTokens: 30000,
      inFlightMarginTokens: 8192,
    })

    expect(type.earlyMarginTokens).toBe(30000)
    expect(type.inFlightMarginTokens).toBe(8192)
    expect(type.toJson().earlyMarginTokens).toBe(30000)
    expect(type.toJson().inFlightMarginTokens).toBe(8192)
  })

  test('upsert insert persists earlyMarginTokens', async () => {
    await AgentType.upsert({
      id: 'upsert-insert-margin-test',
      name: 'Upsert Insert Margin Test',
      model: 'anthropic:claude-sonnet-4-6',
      systemPrompt: 'You are a test agent.',
      earlyMarginTokens: 30000,
      inFlightMarginTokens: 8192,
    })

    const type = await AgentType.mustFind('upsert-insert-margin-test')
    expect(type.earlyMarginTokens).toBe(30000)
    expect(type.inFlightMarginTokens).toBe(8192)
  })

  test('upsert update persists earlyMarginTokens', async () => {
    await AgentType.upsert({
      id: 'upsert-update-margin-test',
      name: 'Upsert Update Margin Test',
      model: 'anthropic:claude-sonnet-4-6',
      systemPrompt: 'You are a test agent.',
      earlyMarginTokens: 30000,
      inFlightMarginTokens: 8192,
    })

    await AgentType.upsert({
      id: 'upsert-update-margin-test',
      name: 'Upsert Update Margin Test',
      model: 'anthropic:claude-sonnet-4-6',
      systemPrompt: 'You are a test agent.',
      earlyMarginTokens: 32000,
      inFlightMarginTokens: 4096,
    })

    const type = await AgentType.mustFind('upsert-update-margin-test')
    expect(type.earlyMarginTokens).toBe(32000)
    expect(type.inFlightMarginTokens).toBe(4096)
  })
})

test('upsert insert persists a tier for tier-only types', async () => {
  await AgentType.upsert({ id: 'tier-only-upsert', name: 'Tier Only', model: '', tier: 'fast', systemPrompt: 'test' })
  const [row] = await db.select().from(agentTypes).where(eq(agentTypes.id, 'tier-only-upsert'))
  expect(row.tier).toBe('fast')
})
