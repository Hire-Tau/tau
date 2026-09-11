import { z } from 'zod'
import { agentConversationLink } from '../../lib/assistantConversationLinks'
import * as squads from '../../api/squads'
import { getAgent } from '../../api/agents'
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
}
const text = z.string().trim().min(1)
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
      'delegate_task',
      'Run a task in the background with the user’s own permissions and report back here. Omit squadId for anything about the whole Tau instance or the user’s account: schedules, integrations, environment variables, secrets, users, permissions, billing, notifications, instance settings, and any investigation or sustained work that is not owned by one squad. Pass squadId (full ID or URL slug) only for work that belongs to that squad: its project, repositories, work streams, incidents, and squad settings. Give every task a short label. Results, progress, and clarification questions arrive in this conversation as task updates; a receipt is not a result and must never be described as one. To continue or answer a task, call this again with inReplyTo set to the update’s id and the same squadId. Delivery is steer (the new request takes priority); pass follow-up only when the user explicitly wants it queued behind the running task. Never send secret values.',
      {
        label: { type: 'string', description: '3–6 words naming the task, e.g. "Check enabled schedules". No status words or secrets.' },
        request: { type: 'string', description: 'Self-contained request from the user’s perspective with every relevant detail, exact URLs, and constraints.' },
        squadId: { type: 'string', description: 'Full squad ID or URL slug when the task belongs to one squad. Omit for instance-wide or personal tasks.' },
        mode: { type: 'string', enum: ['steer', 'follow-up'] },
        inReplyTo: { type: 'string', description: 'Full inbox update UUID when answering or continuing a task update.' },
      },
      ['label', 'request'],
      async (args, env) => {
        if (!env.delegateTask) throw new Error('Background tasks are unavailable in this surface')
        const input = z
          .object({
            label: text.max(80),
            request: text.max(20000),
            squadId: text.optional(),
            mode: z.enum(['steer', 'follow-up']).default('steer'),
            inReplyTo: z.string().uuid().optional(),
          })
          .parse(args)
        const squad = input.squadId ? await squadId(input.squadId, true) : undefined
        return env.delegateTask(input.request, {
          label: input.label,
          squadId: squad,
          mode: input.mode,
          inReplyTo: input.inReplyTo,
        })
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
      'read_squad_files',
      'Read a squad’s shared workspace or its memory. Pass path for a file (paginated with offset) or a directory tree (directory=true or no path). Pass query with source=memory to search indexed memory for relevant context and sources instead of reading a path.',
      {
        squadId: string,
        source: { type: 'string', enum: ['workspace', 'memory'] },
        path: string,
        query: { type: 'string', description: 'Memory search query. Only with source=memory.' },
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
            query: z.string().trim().max(1000).optional(),
            directory: z.boolean().default(false),
            offset: z.number().int().min(0).default(0),
          })
          .refine((value) => !(value.query && value.source !== 'memory'), { message: 'query requires source=memory' })
          .parse(args)
        const id = await squadId(input.squadId)
        if (input.query) return deps.searchMemory(id, { query: input.query, limit: 10 })
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
  ]
}
export const assistantTools = createAssistantTools()
