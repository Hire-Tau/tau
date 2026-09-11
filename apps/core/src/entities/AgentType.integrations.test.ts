import { expect, test } from 'bun:test'
import { AgentType, type AgentTypeRow } from './AgentType'

test('serializes the persisted integration policy without granting an absent policy', () => {
  const base = {
    id: 'test',
    name: 'Test',
    model: 'openai:gpt-5',
    description: null,
    systemPrompt: 'test',
    skills: null,
    extensions: null,
    toolsAllow: null,
    toolsDeny: null,
    extraScopes: null,
    earlyMarginTokens: null,
    inFlightMarginTokens: null,
    yamlTemplate: null,
    yamlFieldOverrides: [],
    disabled: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
  expect(
    new AgentType({ ...base, integrationCapabilities: null } as AgentTypeRow).toJson().integrationCapabilities
  ).toBeNull()

  const policy = { version: 1 as const, allow: { bigbrain: ['agent_tools' as const] } }
  expect(
    new AgentType({ ...base, integrationCapabilities: policy } as AgentTypeRow).toJson().integrationCapabilities
  ).toEqual(policy)
})
