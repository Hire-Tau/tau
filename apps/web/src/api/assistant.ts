import type { AssistantEditorState, AssistantEditorSync } from '@tau/shared'
import type { AssistantConversation, AssistantEntry, AssistantMessageReceipt, AssistantMailbox } from '@tau/shared'
import { webTransport as t } from './transport'
export const assistantApi = {
  editor: (id: string) => t.request<import('@tau/shared').AssistantEditorReadState>(`/assistant/${id}/editor`),
  syncEditor: (id: string, value: AssistantEditorSync) =>
    t.request<AssistantEditorState>(`/assistant/${id}/editor`, { method: 'PUT', body: value }),
  proposeEditor: (id: string, value: unknown) =>
    t.request<AssistantEditorState>(`/assistant/${id}/editor/propose`, { method: 'POST', body: value }),
  closeEditor: (id: string) => t.request(`/assistant/${id}/editor`, { method: 'DELETE' }),
  list: (q = '', offset = 0) =>
    t.request<{ conversations: AssistantConversation[]; hasMore: boolean }>(
      `/assistant?${new URLSearchParams({ q, offset: String(offset) })}`
    ),
  create: (id: string, title?: string) =>
    t.request<AssistantConversation>('/assistant', { method: 'POST', body: { id, title } }),
  history: (id: string, before?: number) =>
    t.request<{
      conversation: AssistantConversation
      entries: AssistantEntry[]
      hasMore: boolean
      before?: number
    }>(`/assistant/${id}${before ? `?before=${before}` : ''}`),
  append: (id: string, entries: AssistantEntry[]) =>
    t.request(`/assistant/${id}/entries`, { method: 'POST', body: { entries } }),
  message: (
    id: string,
    request: string,
    clientId: string,
    options: {
      pagePath?: string
      agentId?: string
      squadId?: string
      label?: string
      mode?: 'steer' | 'follow-up'
      inReplyTo?: string
    } = {}
  ) =>
    t.request<AssistantMessageReceipt>(`/assistant/${id}/messages`, {
      method: 'POST',
      body: { request, clientId, ...options },
    }),
  inbox: (id: string, consumerId: string) =>
    t.request<AssistantMailbox>(`/assistant/${id}/inbox`, {
      method: 'POST',
      body: { consumerId },
    }),
  acknowledge: (id: string, consumerId: string, messageId: string) =>
    t.request(`/assistant/${id}/inbox/ack`, {
      method: 'POST',
      body: { consumerId, messageId },
    }),
  release: (id: string, consumerId: string) =>
    t.request(`/assistant/${id}/inbox/release`, {
      method: 'POST',
      body: { consumerId },
    }),
}
