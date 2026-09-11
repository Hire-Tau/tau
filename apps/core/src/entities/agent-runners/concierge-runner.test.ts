import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { AgentType } from '@tau/shared'
import { AgentSession } from '../AgentSession'
import { toolNameMatchesAny } from '../../lib'
import { AgentType as AgentTypeEntity } from '../AgentType'
import { Squad } from '../Squad'
import { ConciergeRunner } from './concierge-runner'
import * as tools from '../../tools'

const TEST_SQUAD_ID = '00000000-0000-4000-8000-000000000101'

let codingToolCalls: unknown[] = []
let squadSandboxCalls: unknown[] = []
let lightSandboxCalls: unknown[] = []

class TestableConciergeRunner extends ConciergeRunner {
  exposeCreateSession(): Promise<AgentSession> {
    return this.createSession()
  }

  protected override ensureSquadSandbox(squad: Squad) {
    squadSandboxCalls.push(squad)
    return Promise.resolve('/tmp/squad-workspace')
  }

  protected ensureLightSandbox(args: any) {
    lightSandboxCalls.push(args)
    return Promise.resolve('/tmp/light-workspace')
  }

  protected override createCodingTools(workspacePath: string, sandboxId: string, tauToken?: string, squadId?: string) {
    codingToolCalls.push([workspacePath, sandboxId, tauToken, squadId])
    return [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'bash' }] as any
  }
}

function makeAgentType(overrides: Partial<AgentType> = {}): AgentType {
  return {
    id: 'test-type',
    model: 'anthropic:claude-sonnet-4-5',
    name: 'Test Agent',
    description: null,
    systemPrompt: 'You are a test agent.',
    skills: null,
    extensions: null,
    toolsAllow: null,
    toolsDeny: null,
    earlyMarginTokens: null,
    inFlightMarginTokens: null,
    yamlFieldOverrides: [],
    hasTemplate: false,
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeTestAgent(overrides: { agentTypeId?: string; squadId?: string | null } = {}) {
  const base = {
    id: crypto.randomUUID(),
    agentTypeId: 'concierge',
    squadId: null,
    metadata: null,
    modelOverride: null,
    selectedModel: null,
    async getOrCreateToken() {
      return undefined
    },
    async getEffectiveModelSpec(model: string) {
      return model
    },
    ...overrides,
  }
  return {
    ...base,
    async getSandboxId() {
      return `agent_${base.agentTypeId}_${base.id}`
    },
  } as any
}

function makeExecution(agentId: string) {
  return {
    id: 'execution-1',
    agentId,
    message: 'test',
    imageIds: null,
  } as any
}

describe('ConciergeRunner.createSession', () => {
  let agentSessionCreateSpy: any
  let agentTypeFindSpy: any
  let squadFindSpy: any
  let getShortTermMemorySpy: any
  let createWebToolsSpy: any
  let createBrowserToolsSpy: any
  let resolveSkillPathsSpy: any
  let resolveExtensionPathsSpy: any

  beforeEach(() => {
    codingToolCalls = []
    squadSandboxCalls = []
    lightSandboxCalls = []
    agentSessionCreateSpy = spyOn(AgentSession, 'create').mockResolvedValue({} as AgentSession)
    agentTypeFindSpy = spyOn(AgentTypeEntity, 'find').mockResolvedValue({
      id: 'concierge',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'You are concierge {{agent.id}}.',
      yamlTemplate: {},
    } as any)
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: TEST_SQUAD_ID,
      name: 'Test Squad',
      purpose: 'Testing concierge',
      sandboxId: 'squad-sandbox-1',
      isMemoryEnabled: false,
    } as any)
    getShortTermMemorySpy = spyOn(tools, 'getShortTermMemory').mockResolvedValue('')
    createWebToolsSpy = spyOn(tools, 'createWebTools').mockReturnValue([{ name: 'websearch' }] as any)
    createBrowserToolsSpy = spyOn(tools, 'createBrowserTools').mockReturnValue([{ name: 'browser_open' }] as any)
    resolveSkillPathsSpy = spyOn(ConciergeRunner.prototype as any, 'resolveSkillPaths').mockResolvedValue(undefined)
    resolveExtensionPathsSpy = spyOn(ConciergeRunner.prototype as any, 'resolveExtensionPaths').mockReturnValue(
      undefined
    )
  })

  afterEach(() => {
    agentSessionCreateSpy?.mockRestore()
    agentTypeFindSpy?.mockRestore()
    squadFindSpy?.mockRestore()
    getShortTermMemorySpy?.mockRestore()
    createWebToolsSpy?.mockRestore()
    createBrowserToolsSpy?.mockRestore()
    resolveSkillPathsSpy?.mockRestore()
    resolveExtensionPathsSpy?.mockRestore()
  })

  it('passes concierge tool allow/deny policy so code-authoring tools are denied', async () => {
    const agent = makeTestAgent({ agentTypeId: 'concierge', squadId: TEST_SQUAD_ID })
    const agentType = makeAgentType({
      id: 'concierge',
      toolsAllow: ['read', 'bash', 'websearch', 'webfetch', 'browser_*'],
      toolsDeny: ['write', 'edit'],
    }) as AgentType
    const runner = new TestableConciergeRunner(makeExecution(agent.id), agent, agentType)

    await runner.exposeCreateSession()

    const config = agentSessionCreateSpy.mock.calls[0][0]
    const availableToolNames = config.tools.available.map((tool: any) => tool.name)
    expect(availableToolNames).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'bash']))
    expect(config.tools.allow).toEqual(expect.arrayContaining(['read', 'bash', 'websearch', 'webfetch', 'browser_*']))
    expect(config.tools.deny).toEqual(expect.arrayContaining(['write', 'edit']))

    const effectiveToolNames = availableToolNames.filter(
      (name: string) => toolNameMatchesAny(config.tools.allow, name) && !toolNameMatchesAny(config.tools.deny, name)
    )
    expect(effectiveToolNames).toEqual(expect.arrayContaining(['read', 'bash', 'websearch', 'browser_open']))
    expect(effectiveToolNames).not.toContain('write')
    expect(effectiveToolNames).not.toContain('edit')
    expect(config.systemPrompt).toContain('`read`')
    expect(config.systemPrompt).toContain('`bash`')
    expect(config.systemPrompt).not.toContain('`write`')
    expect(config.systemPrompt).not.toContain('`edit`')
    expect(config.systemPrompt).toContain('dispatched subagents')
    expect(config.systemPrompt).not.toContain('keys and secrets')
  })

  it('uses the per-agent light id (getSandboxId) for coding tools and session sandbox, not squad.sandboxId', async () => {
    const agent = makeTestAgent({ agentTypeId: 'concierge', squadId: TEST_SQUAD_ID })
    const agentType = makeAgentType({ id: 'concierge' }) as AgentType
    const runner = new TestableConciergeRunner(makeExecution(agent.id), agent, agentType)

    await runner.exposeCreateSession()

    const lightId = `agent_concierge_${agent.id}`

    // ensureSquadSandbox (warm box) must still be called
    expect(squadSandboxCalls).toHaveLength(1)

    // ensureLightSandbox must be called with the light id and squadId
    expect(lightSandboxCalls).toHaveLength(1)
    expect(lightSandboxCalls[0]).toMatchObject({ sandboxId: lightId, workspaceId: lightId, squadId: TEST_SQUAD_ID })

    // createCodingTools must receive the light id as sandboxId and the squad id as the 4th arg
    expect(codingToolCalls).toHaveLength(1)
    const codingCall = codingToolCalls[0] as unknown[]
    expect(codingCall[0]).toBe('/tmp/light-workspace')
    expect(codingCall[1]).toBe(lightId)
    expect(codingCall[3]).toBe(TEST_SQUAD_ID)

    // resolveSkillPaths must be called with the light id (not squad.sandboxId)
    expect(resolveSkillPathsSpy.mock.calls[0]?.[0]).toBe(lightId)

    // AgentSession.create sandbox.sandboxId must be the light id and sandbox.squadId must be the squad id
    const sessionConfig = agentSessionCreateSpy.mock.calls[0][0]
    expect(sessionConfig.sandbox.sandboxId).toBe(lightId)
    expect(sessionConfig.sandbox.squadId).toBe(TEST_SQUAD_ID)
  })
})
