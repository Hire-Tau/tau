import { z } from 'zod'
import { agentConversationLink } from '../../lib/assistantConversationLinks'
import * as squads from '../../api/squads'
import { getAgent, sendAgentMessage } from '../../api/agents'
import { listGlobalActivity } from '../../api/activity'
import { listPendingActions } from '../../api/actions'
import { answerAgentQuestion, dismissAgentQuestion } from '../../api/agentQuestions'
import { markAsRead } from '../../api/inbox'
import * as workspace from '../../api/workspace'
import { searchMemory } from '../../api/memory'
import { searchEntities } from '../../api/search'
import { hybridTauSearch } from '../../lib/hybridTauSearch'
import { ALL_SECTIONS, isSectionAllowed } from '../../components/settings/settingsSections'
import { resolveVoiceSquadId } from '../squadReferences'
import type { VoiceAssistantTool, VoiceToolExecutor } from './types'

export interface AssistantToolEnvironment extends VoiceToolExecutor {
  can?: (permission: string) => boolean
  messageUserAssistant?: (request: string, mode?: 'steer' | 'follow-up', inReplyTo?: string) => Promise<unknown>
}
const text = z.string().trim().min(1)
// Accept legacy UI result IDs at the tool boundary, never pass them to the API.
const workStreamId = text.transform((value) => value.replace(/^work:/, '')).pipe(z.string().uuid())
const limit = z.number().int().min(1).max(50).default(20)
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  execute: VoiceAssistantTool<AssistantToolEnvironment>['execute']
): VoiceAssistantTool<AssistantToolEnvironment> {
  return {
    definition: {
      type: 'function',
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
    execute,
  }
}
const string = { type: 'string' }
const number = { type: 'integer', minimum: 1, maximum: 50 }
const depsDefault = {
  squads,
  getAgent,
  sendAgentMessage,
  listGlobalActivity,
  listPendingActions,
  answerAgentQuestion,
  dismissAgentQuestion,
  markAsRead,
  workspace,
  searchMemory,
  searchEntities,
}
export function createAssistantTools(
  overrides: Partial<typeof depsDefault> = {}
): VoiceAssistantTool<AssistantToolEnvironment>[] {
  const deps = { ...depsDefault, ...overrides }
  async function squadId(reference: string, activeOnly = false) {
    const id = resolveVoiceSquadId(reference, await deps.squads.listSquads(activeOnly ? 'active' : undefined))
    if (!id) throw new Error('Unknown or ambiguous squad. Search for its full ID first.')
    return id
  }
  async function verifiedSquadManager(id: string) {
    const agents = await deps.squads.listSquadAgents(id)
    const managers = agents.filter(
      (agent) =>
        agent.squadId === id && agent.agentTypeId === 'manager' && !['terminated', 'dormant'].includes(agent.status)
    )
    if (managers.length !== 1)
      throw new Error('Could not identify one available manager for this squad. No message sent.')
    const manager = await deps.getAgent(managers[0]!.id)
    if (
      manager.id !== managers[0]!.id ||
      manager.squadId !== id ||
      manager.agentTypeId !== 'manager' ||
      ['terminated', 'dormant'].includes(manager.status)
    )
      throw new Error('The manager’s squad or availability changed. No message sent.')
    return manager
  }
  return [
    tool(
      'show_conversation',
      'Offer a nested conversation link to an existing agent without sending a message. Use open=true only when the user asks to open or go to the conversation (in text or voice). Opening preserves the Assistant conversation and live voice recipient; Back returns here. Successful message tools already display a conversation link, so do not call this again after sending.',
      {
        agentId: string,
        open: {
          type: 'boolean',
          description: 'Open immediately only for an explicit navigation request; otherwise show a link.',
        },
      },
      ['agentId'],
      async (args, env) => {
        const input = z.object({ agentId: text, open: z.boolean().default(false) }).parse(args)
        const agent = await deps.getAgent(input.agentId)
        const conversation = agentConversationLink(agent)
        if (input.open && env.openConversation) env.openConversation(conversation)
        return { ok: true, conversation, opened: input.open && Boolean(env.openConversation) }
      }
    ),
    tool(
      'search_tau',
      'Find pages, settings, squads, consultant conversations, work streams, and saved Assistant conversations. Returns canonical IDs and links.',
      { query: string, limit: number },
      ['query'],
      async (args, env) => {
        const input = z.object({ query: text.max(120), limit }).parse(args)
        const allowed = new Set(
          ALL_SECTIONS.filter((section) => isSectionAllowed(section.id, env.can ?? (() => false), false)).map(
            (section) => section.id
          )
        )
        return hybridTauSearch(input.query, input.limit, allowed, deps.searchEntities)
      }
    ),
    tool(
      'inspect_work_stream',
      'Read a work stream’s description, status, assignments, waits, and metadata.',
      { id: string },
      ['id'],
      async (args) => deps.squads.getWorkStream(z.object({ id: workStreamId }).parse(args).id)
    ),
    tool(
      'message_squad_manager',
      'Route a new project report, incident, or squad-owned work request directly to the relevant squad manager. Global or personal Tau settings, environment variables, secrets, and integration accounts belong to message_user_assistant unless the user explicitly requests a squad/project change. The current page alone does not establish squad ownership. Match the squad by name and purpose in session context and pass its ID. No existing work stream is required; the manager owns triage and work creation. Use this before investigating or searching for matching work. A successful receipt confirms submission, not completion.',
      {
        squadId: { type: 'string', description: 'Full squad ID from session context or lookup, or its URL slug.' },
        content: {
          type: 'string',
          description:
            'Self-contained user report with exact URLs, symptoms, affected system, and constraints. Do not invent a diagnosis.',
        },
      },
      ['squadId', 'content'],
      async (args, env) => {
        const input = z.object({ squadId: text, content: text.max(20000) }).parse(args)
        const id = await squadId(input.squadId, true)
        const manager = await verifiedSquadManager(id)
        if (env.messageAgent)
          return {
            receipt: await env.messageAgent(manager.id, input.content, 'follow-up'),
            squadId: id,
            managerId: manager.id,
          }
        const result = await deps.sendAgentMessage(manager.id, input.content, undefined, 'follow-up')
        return { ok: result.success, agentStatus: result.status, squadId: id, managerId: manager.id }
      }
    ),
    tool(
      'message_work_stream_manager',
      'Ask the manager of a verified work stream to pause, resume, or coordinate that work. Resolves the manager from the work stream’s squad; never guesses an agent. Use this instead of message_agent for work-stream coordination. A successful send means the request was delivered, not that the requested action is complete.',
      { workStreamId: string, content: string },
      ['workStreamId', 'content'],
      async (args, env) => {
        const input = z.object({ workStreamId, content: text.max(20000) }).parse(args)
        const work = await deps.squads.getWorkStream(input.workStreamId)
        if (work.id !== input.workStreamId || !work.squadId)
          throw new Error('Could not verify the work stream’s squad. No message sent.')
        const manager = await verifiedSquadManager(work.squadId)
        if (env.messageAgent)
          return {
            receipt: await env.messageAgent(
              manager.id,
              `Work stream: ${work.title} (${work.id})\n\n${input.content}`,
              'steer'
            ),
            workStreamId: work.id,
            squadId: work.squadId,
            managerId: manager.id,
          }
        const result = await deps.sendAgentMessage(
          manager.id,
          `Work stream: ${work.title} (${work.id})\n\n${input.content}`,
          undefined,
          'steer'
        )
        return {
          ok: result.success,
          agentStatus: result.status,
          workStreamId: work.id,
          squadId: work.squadId,
          managerId: manager.id,
        }
      }
    ),
    tool(
      'read_activity',
      'Read recent activity across accessible squads, optionally limited to one squad.',
      { squadId: string, limit: number },
      [],
      async (args) => {
        const input = z.object({ squadId: text.optional(), limit }).parse(args)
        return input.squadId
          ? deps.squads.listSquadActivity(await squadId(input.squadId), { limit: input.limit })
          : deps.listGlobalActivity({ limit: input.limit })
      }
    ),
    tool(
      'read_squad_file',
      'List directories or read a bounded excerpt from squad workspace or memory. Paths are scoped by the server. Omit path to list the root.',
      {
        squadId: string,
        source: { type: 'string', enum: ['workspace', 'memory'] },
        path: string,
        directory: { type: 'boolean' },
        offset: { type: 'integer', minimum: 0 },
      },
      ['squadId', 'source'],
      async (args) => {
        const input = z
          .object({
            squadId: text,
            source: z.enum(['workspace', 'memory']),
            path: z.string().max(2000).optional(),
            directory: z.boolean().default(false),
            offset: z.number().int().min(0).default(0),
          })
          .parse(args)
        const id = await squadId(input.squadId)
        const memory = input.source === 'memory'
        if (!input.path || input.directory)
          return memory
            ? deps.workspace.getSquadMemoryTree(id, input.path)
            : deps.workspace.getSquadWorkspaceTree(id, input.path)
        const file = memory
          ? await deps.workspace.getSquadMemoryFile(id, input.path)
          : await deps.workspace.getSquadWorkspaceFile(id, input.path)
        if (file.binary) return { path: file.path, binary: true, size: file.size }
        const content = file.content.slice(input.offset, input.offset + 12000)
        return {
          path: file.path,
          content,
          totalLength: file.content.length,
          nextOffset: input.offset + content.length < file.content.length ? input.offset + content.length : null,
        }
      }
    ),
    tool(
      'search_memory',
      'Search a squad’s indexed memory for relevant context and sources.',
      { squadId: string, query: string },
      ['squadId', 'query'],
      async (args) => {
        const input = z.object({ squadId: text, query: text.max(1000) }).parse(args)
        return deps.searchMemory(await squadId(input.squadId), { query: input.query, limit: 10 })
      }
    ),
    tool(
      'list_attention',
      'List the user’s actionable questions, blocked work, and items needing a decision, with their action IDs.',
      {},
      [],
      async () => deps.listPendingActions()
    ),
    tool(
      'answer_question',
      'Answer a specific agent question using the answer the user provided. Read the attention item first; do not invent a user decision.',
      { questionId: string, answer: string },
      ['questionId', 'answer'],
      async (args) => {
        const input = z.object({ questionId: text, answer: text.max(20000) }).parse(args)
        return deps.answerAgentQuestion(input.questionId, input.answer)
      }
    ),
    tool(
      'dismiss_question',
      'Dismiss an agent question when the user asks to dismiss it.',
      { questionId: string, reason: string },
      ['questionId'],
      async (args) => {
        const input = z.object({ questionId: text, reason: z.string().max(2000).optional() }).parse(args)
        return deps.dismissAgentQuestion(input.questionId, input.reason)
      }
    ),
    tool(
      'dismiss_notification',
      'Mark a notification read when the user asks to dismiss it. Does not resolve associated agent questions.',
      { messageId: string },
      ['messageId'],
      async (args) => deps.markAsRead(z.object({ messageId: text }).parse(args).messageId)
    ),
    tool(
      'set_subscription',
      'Watch or unwatch a squad or work stream for this user.',
      { scope: { type: 'string', enum: ['squad', 'work_stream'] }, id: string, watching: { type: 'boolean' } },
      ['scope', 'id', 'watching'],
      async (args) => {
        const input = z.object({ scope: z.enum(['squad', 'work_stream']), id: text, watching: z.boolean() }).parse(args)
        if (input.scope === 'squad')
          return (input.watching ? deps.squads.subscribeSquad : deps.squads.unsubscribeSquad)(await squadId(input.id))
        return (input.watching ? deps.squads.subscribeWorkStream : deps.squads.unsubscribeWorkStream)(input.id)
      }
    ),
    tool(
      'message_user_assistant',
      'Send global or personal Tau administration, sustained work, or a question to your paired User Assistant, which works with the user’s Tau API permissions. Use this for environment variables, secrets, integration accounts/defaults, users, permissions, and instance settings, even while viewing a squad page. Unscoped settings requests go here for scope resolution; do not infer squad ownership from the current page. Returns an inbox receipt immediately, not the result. Progress, clarification questions and results arrive as separate inbox updates. Requests run sequentially on the same agent. Include inReplyTo when answering an update. Use steer for an explicit correction or stop request; follow-up otherwise. Ask the user here when clarification or approval is needed; never infer approval.',
      { request: string, mode: { type: 'string', enum: ['steer', 'follow-up'] }, inReplyTo: string },
      ['request'],
      async (args, env) => {
        if (!env.messageUserAssistant) throw new Error('Assistant messaging is unavailable in this surface')
        const input = z
          .object({
            request: text.max(20000),
            mode: z.enum(['steer', 'follow-up']).optional(),
            inReplyTo: z.string().uuid().optional(),
          })
          .parse(args)
        return env.messageUserAssistant(input.request, input.mode, input.inReplyTo)
      }
    ),
  ]
}
export const assistantTools = createAssistantTools()
