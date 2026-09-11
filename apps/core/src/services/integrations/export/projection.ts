import type { SanitizedConversationRecord } from '../types'

export interface ProjectableMessage {
  id: string
  agentId: string
  role: 'human' | 'assistant'
  content: string
  metadata: unknown
  pending: boolean
  enqueueOrder: bigint | null
  createdAt: Date
}

export interface ProjectionContext {
  agentId: string
  executionId: string
  consentingUserId: string
  adoptedEnqueueOrder: bigint
  policyVersion: number
  projectionVersion: number
  knownSecrets?: readonly string[]
}

export type ProjectionResult =
  | { included: true; records: readonly SanitizedConversationRecord[]; firstOrder: bigint; lastOrder: bigint }
  | { included: false; code: string }

/** Projects one completed execution. Any uncertain provenance excludes the entire execution. */
export function projectCompletedExecution(
  messages: readonly ProjectableMessage[],
  context: ProjectionContext
): ProjectionResult {
  if (context.policyVersion !== 1 || context.projectionVersion !== 1) return excluded('unsupported_projection')
  if (messages.length === 0) return excluded('empty_execution')
  const ordered = [...messages].sort((a, b) => Number((a.enqueueOrder ?? 0n) - (b.enqueueOrder ?? 0n)))
  const records: SanitizedConversationRecord[] = []
  for (const message of ordered) {
    if (
      message.agentId !== context.agentId ||
      message.pending ||
      message.enqueueOrder === null ||
      message.enqueueOrder <= context.adoptedEnqueueOrder
    )
      return excluded('outside_consent_window')
    const metadata = object(message.metadata)
    if (
      !metadata ||
      metadata.deletedAt ||
      metadata.redactedAt ||
      metadata.externalExport === 'disabled' ||
      metadata.imageIds ||
      metadata.attachments
    )
      return excluded('excluded_content')
    if (message.role === 'human') {
      const sender = object(metadata.sender)
      if (
        metadata.source !== 'user_chat' ||
        metadata.executionId !== context.executionId ||
        sender?.userId !== context.consentingUserId
      )
        return excluded('untrusted_user_provenance')
      records.push(record('user', message, context.knownSecrets))
    } else {
      if (metadata.executionId !== context.executionId) return excluded('untrusted_assistant_provenance')
      records.push(record('assistant', message, context.knownSecrets))
    }
  }
  if (!records.some((entry) => entry.role === 'user') || !records.some((entry) => entry.role === 'assistant'))
    return excluded('incomplete_execution')
  return { included: true, records, firstOrder: ordered[0]!.enqueueOrder!, lastOrder: ordered.at(-1)!.enqueueOrder! }
}

function record(
  role: 'user' | 'assistant',
  message: ProjectableMessage,
  knownSecrets: readonly string[] = []
): SanitizedConversationRecord {
  return {
    role,
    text: redactConversationText(message.content, knownSecrets),
    sourceMessageId: message.id,
    createdAt: message.createdAt,
  }
}

export function redactConversationText(raw: string, knownSecrets: readonly string[]): string {
  let text = raw
  for (const secret of [...new Set(knownSecrets.filter((value) => value.length >= 4))].sort(
    (a, b) => b.length - a.length
  ))
    text = text.split(secret).join('[REDACTED]')
  return text
    .replace(/\b(?:authorization\s*:\s*)?(?:bearer|basic)\s+[A-Za-z0-9._~+\x2F-]{8,}/gi, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]')
}

function object(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null
}
function excluded(code: string): ProjectionResult {
  return { included: false, code }
}
