import { expect, test } from 'bun:test'
import { assistantConversationLink } from './assistantConversationLinks'
import type { VoiceTranscriptEntry } from '../voice/types'

const conversation = { agentId: 'manager', squadId: 'squad', label: 'Squad manager' }
const entry = (result: unknown, extra: Partial<VoiceTranscriptEntry> = {}): VoiceTranscriptEntry => ({
  role: 'tool',
  final: true,
  text: '',
  toolName: 'message_squad_manager',
  toolResult: JSON.stringify(result),
  ...extra,
})

test('message receipts and offered conversations expose durable nested links without replaying sends', () => {
  expect(assistantConversationLink(entry({ receipt: { id: 'message', conversation, delivered: false } }))).toEqual(
    conversation
  )
  expect(assistantConversationLink(entry({ conversation }, { toolName: 'show_conversation' }))).toEqual(conversation)
  expect(assistantConversationLink(entry({ receipt: { id: 'message', agentId: 'manager' } }))).toEqual({
    agentId: 'manager',
    label: 'Agent conversation',
  })
})

test('failed, unfinished, malformed, and unrelated tools never create conversation links', () => {
  for (const bad of [
    entry({ conversation, error: 'Forbidden' }),
    entry({ receipt: { conversation, ok: false } }),
    entry({ conversation }, { toolError: true }),
    entry({ conversation }, { final: false }),
    entry({ conversation }, { role: 'assistant' }),
    entry({ conversation }, { toolName: 'read_squad_file' }),
    entry({ conversation: { agentId: '', label: 'Bad' } }),
    entry({}, { toolResult: '{' }),
  ])
    expect(assistantConversationLink(bad)).toBeUndefined()
})

const receipt = (toolName: string, result: unknown) => ({
  role: 'tool' as const,
  final: true,
  text: '',
  toolName,
  toolResult: JSON.stringify(result),
})

test('delegate_task receipts carry the task label and kind', () => {
  expect(
    assistantConversationLink(
      receipt('delegate_task', {
        id: 'm',
        agentId: 'a',
        delivered: true,
        kind: 'squad',
        squadId: 's',
        conversation: { agentId: 'a', squadId: 's', label: 'Check enabled schedules', kind: 'squad' },
      })
    )
  ).toEqual({ agentId: 'a', squadId: 's', label: 'Check enabled schedules', kind: 'squad' })
})

test('navigate agent offers and legacy message receipts still produce links', () => {
  expect(
    assistantConversationLink(receipt('navigate', { ok: true, conversation: { agentId: 'a', label: 'Morgan' } }))
  ).toEqual({ agentId: 'a', label: 'Morgan' })
  expect(assistantConversationLink(receipt('navigate', { ok: true, navigatedTo: '/x' }))).toBeUndefined()
  expect(assistantConversationLink(receipt('navigate', { ok: true, id: 'm', agentId: 'a' }))).toBeUndefined()
  for (const name of ['message_user_assistant', 'message_squad_manager', 'message_work_stream_manager', 'show_conversation'])
    expect(assistantConversationLink(receipt(name, { receipt: { id: 'm', agentId: 'a' } }))?.agentId).toBe('a')
})
