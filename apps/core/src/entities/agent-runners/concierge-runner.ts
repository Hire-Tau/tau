/**
 * Concierge Runner
 *
 * Runner for concierge agents — platform-level agents that handle
 * requests from external channels (Discord, Slack, Telegram).
 *
 * ## Channel Context Flow
 *
 * 1. **Webhook receives request** (webhooks.ts)
 *    - Verifies signature, parses inbound message
 *    - Calls `channelInstance.queueForConcierge()` which sends inbox message
 *
 * 2. **Inbox message stores channel context** (ChannelInstance.queueForConcierge)
 *    - The `responseContext` from the parsed inbound message is stored in
 *      inbox message metadata as `{ type: 'channel_message', channelContext: {...} }`
 *    - This includes provider-specific fields needed to send responses
 *      (e.g., interactionToken for Discord, responseUrl for Slack, chatId for Telegram)
 *
 * 3. **Concierge processes messages from inbox**
 *    - Each inbox message represents one user request with its own channel context
 *    - Concierge can handle multiple messages, responding to each specifically
 *
 * 4. **Channel response tools**
 *    - `channel_respond` uses a specific inbox message ID for the initial response
 *    - `channel_send` posts follow-up messages to the active channel thread
 *    - `channel_edit` updates tracked Tau-sent provider message IDs
 *
 * Key features:
 * - Supports handling multiple concurrent channel messages
 * - Each response explicitly targets a specific inbox message
 * - Messages are marked read after responding
 */

import type { SessionUsage, MessageMetadata } from '@tau/shared'
import { AgentRunner } from './base'
import type { AdmissionScope } from '../../services/maintenance/admission-reservation'

import { AgentType } from '../AgentType'
import { resolveAgentTypeChain } from '../../services/model-selection/model-tier-resolution'
import { ensureSquadSandbox, ensureWorkspaceSandbox } from '../../services/sandbox/ensure'
import { AgentSession } from '../AgentSession'
import {
  getShortTermMemory,
  formatShortTermMemoryPrompt,
  createChannelRespondTool,
  createChannelSendTool,
  createChannelEditTool,
  createMemoryTools,
  createSetAgentPurposeTool,
  createSquadTodoTools,
  createWebTools,
  createBrowserTools,
  createSuggestSquadTool,
} from '../../tools'
import { createNotifyContactTool } from '../../tools/notify-contact'
import { createDispatchTool } from '../../tools/dispatch'
import { filterToolsByPolicy } from '../../lib/tools'
import { createSubagentLifecycleTools } from '../../tools/subagents'
import { Squad } from '../Squad'
import { prompt, interpolateTemplate, buildPlatformUrlsPrompt } from '../../lib/prompts'
import { composeAgentTypePrompt } from '../../services/agent-types/compose-prompt'
import { buildWorkspacePrompt, workspaceToolNamesForPolicy } from '../../lib/prompts/workspace-prompt'
import type { ScopeRequest } from '../../services/memory/access/scope-expander'
import {
  AGENT_PURPOSE_DISPLAY_SECTION_TITLE,
  SET_AGENT_PURPOSE_INSTRUCTIONS,
} from '../../lib/prompts/agent-purpose-prompt'

export class ConciergeRunner extends AgentRunner {
  private squad!: Squad

  protected ensureSquadSandbox(
    squad: Squad,
    scope: AdmissionScope | null = null,
    setupProgress?: NonNullable<Parameters<typeof ensureSquadSandbox>[1]>['setupProgress']
  ): Promise<string> {
    return ensureSquadSandbox(squad, { admissionScope: scope, setupProgress })
  }

  protected ensureLightSandbox(args: Parameters<typeof ensureWorkspaceSandbox>[0]): Promise<string> {
    return ensureWorkspaceSandbox(args)
  }

  // ---------------------------------------------------------------------------
  // Prompt builders
  // ---------------------------------------------------------------------------

  private async buildConciergePrompt(): Promise<{ systemPrompt: string; model: string }> {
    const agentType = await AgentType.find('concierge')
    if (!agentType) {
      throw new Error('Concierge agent type not found')
    }

    const sandboxId = await this.agent.getSandboxId()
    const typePrompt = await composeAgentTypePrompt(agentType)
    const rawPrompt = prompt()
      .text(typePrompt)
      .section('Your squad', `${this.squad.name} (${this.squad.id.slice(0, 8)})\n${this.squad.purpose ?? ''}`)
      // Concierge runs in its own light box (/private) with the shared squad
      // workspace mounted, but has no squad_bash (single private bash only).
      .text(
        buildWorkspacePrompt({
          squadId: this.squad.id,
          squadName: this.squad.name,
          sandboxId,
          hasSquadBash: false,
          toolNames: workspaceToolNamesForPolicy(this.agentType.toolsAllow, this.agentType.toolsDeny),
          mayShareWithSubagents: true,
        })
      )
      .text(buildPlatformUrlsPrompt())
      .build()

    // Interpolate {{agent.id}} and other placeholders
    const systemPrompt = interpolateTemplate(rawPrompt, {
      'agent.id': this.agent.id,
    })

    return { systemPrompt, model: await resolveAgentTypeChain(agentType, this.agent.modelOverride) }
  }

  // ---------------------------------------------------------------------------
  // Session setup
  // ---------------------------------------------------------------------------

  protected async createSession(scope: AdmissionScope | null = null): Promise<AgentSession> {
    if (!this.agent.squadId) {
      throw new Error('Concierge agent has no squadId (must be squad-scoped)')
    }
    const squad = await Squad.find(this.agent.squadId)
    if (!squad) {
      await this.handleMissingResource(`Squad ${this.agent.squadId}`)
      throw new Error(`Squad ${this.agent.squadId} not found`)
    }
    this.squad = squad

    const { sandboxId: lightId, skillPaths, extensionPaths } = await this.resolveSessionPaths()

    // Run squad-level provisioning concurrently with the agent's light container —
    // distinct sandbox ids; the light box self-provisions its own dirs; env/files
    // are read at command-exec time after both ensures resolve.
    const workspacePath = await this.withSandboxSetupBatch(async () => {
      await this.ensureSquadSandbox(squad, scope, this.sandboxSetupProgress)
      return this.ensureLightSandbox({
        sandboxId: lightId,
        workspaceId: lightId,
        squadId: squad.id,
        admissionScope: scope,
        setupProgress: this.sandboxSetupProgress,
      })
    })

    const [conciergePromptResult, shortTermMemory, agentType] = await Promise.all([
      this.buildConciergePrompt(),
      getShortTermMemory(this.agent.id),
      AgentType.find('concierge'),
    ])

    const systemPrompt = prompt()
      .text(conciergePromptResult.systemPrompt)
      .text(formatShortTermMemoryPrompt(shortTermMemory))
      .section(AGENT_PURPOSE_DISPLAY_SECTION_TITLE, SET_AGENT_PURPOSE_INSTRUCTIONS)
      .section(
        'Channel response flow',
        [
          '- Use channel_respond once/early for the current inbound inbox message; it replaces the initial placeholder and marks that inbox message read.',
          '- Use channel_send for later progress or final follow-up messages in the active channel thread.',
          '- Use channel_edit only for provider message IDs previously returned/tracked from Tau-sent messages.',
        ].join('\n')
      )
      .build()

    const { baseTools, sandboxStatusTool, shortTermMemoryTools } = await this.buildSessionToolkit({
      workspacePath,
      sandboxId: lightId,
      squadId: squad.id,
    })
    const webTools = createWebTools()
    const browserTools = createBrowserTools(this.agent.id, lightId)
    const environmentTools = [...baseTools, ...webTools, ...browserTools]
    const notifyContactTool = createNotifyContactTool({ agentId: this.agent.id })
    const subagentLifecycleTools = createSubagentLifecycleTools({ agentId: this.agent.id })
    const setAgentPurposeTool = createSetAgentPurposeTool({ agentId: this.agent.id })
    const todoTools = createSquadTodoTools(squad.id, this.agent.id)

    const channelRespondTool = createChannelRespondTool()
    const channelSendTool = createChannelSendTool(this.agent.id)
    const channelEditTool = createChannelEditTool(this.agent.id)
    const suggestSquadTool = createSuggestSquadTool({ squadId: squad.id })

    const tmpl = agentType?.yamlTemplate as { memory?: { searchDefaults?: Partial<ScopeRequest> } } | undefined
    const memoryTools = squad.isMemoryEnabled
      ? createMemoryTools(squad.id, {
          searchDefaults: {
            agentType: tmpl?.memory?.searchDefaults,
            agent: (this.agent.metadata as { memory?: { searchDefaults?: Partial<ScopeRequest> } } | null | undefined)
              ?.memory?.searchDefaults,
          },
        })
      : []

    return this.createPiSession(scope, async () => {
      const sessionOptions = await this.buildBaseSessionOptions({
        systemPrompt,
        skillPaths,
        extensionPaths,
        sandboxId: lightId,
        workspacePath,
        squadId: squad.id,
        // The concierge resolves its model from the concierge AgentType, not
        // the agent's own effective spec.
        model: conciergePromptResult.model,
        tools: {
          core: [
            channelRespondTool,
            channelSendTool,
            channelEditTool,
            notifyContactTool,
            ...subagentLifecycleTools,
            setAgentPurposeTool,
            ...(sandboxStatusTool ? [sandboxStatusTool] : []),
            ...todoTools,
            ...shortTermMemoryTools,
            ...memoryTools,
            suggestSquadTool,
          ],
          available: environmentTools,
        },
      })
      const effectiveEnvironmentTools = filterToolsByPolicy(
        sessionOptions.tools?.available ?? [],
        sessionOptions.tools?.allow,
        sessionOptions.tools?.deny
      )
      sessionOptions.tools!.core = [
        ...(sessionOptions.tools?.core ?? []),
        createDispatchTool({
          agentId: this.agent.id,
          parentExecutionContext: {
            version: 1,
            squadId: squad.id,
            environmentToolNames: effectiveEnvironmentTools.map((tool) => tool.name),
          },
        }),
      ]
      return AgentSession.create(sessionOptions)
    })
  }

  protected override pushAgentEvent(): void {
    this.buffer.push({
      type: 'agent',
      agentId: this.agent.id,
      scope: { type: 'concierge' },
      executionId: this.execution.id,
    })
  }

  // ---------------------------------------------------------------------------
  // Completion
  // ---------------------------------------------------------------------------

  protected async onComplete(
    response: string,
    metadata: MessageMetadata | undefined,
    sessionUsage: SessionUsage
  ): Promise<void> {
    await this.completeNormally(response, metadata, sessionUsage)
  }

  // Uses base onError — marks failed + idle
}
