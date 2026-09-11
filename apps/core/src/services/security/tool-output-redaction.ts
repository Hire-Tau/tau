/**
 * Inbound tool-output redaction.
 *
 * The security boundary that matters is the one the agent reads. Tool results
 * are the only untrusted content that enters the model's context: pi builds the
 * `toolResult` message from `AgentToolResult.content` and nothing else, so
 * redacting that array before `execute` returns means a stored secret is never
 * processed by the model, never written to the session file, and never sent to
 * the provider.
 *
 * Two properties make this boundary cheap where the old outbound one was not:
 *
 * - It sees whole values. `onUpdate` partials feed display events only and never
 *   reach the model, so there is no chunk boundary to hold back across and no
 *   streaming redactor to keep in sync.
 * - It is total. Agents run with `noTools: 'builtin'`, so wrapping the registered
 *   tool list covers every tool the agent can call, including ones added later.
 *
 * Content the agent itself authored (tool arguments, assistant text) is not
 * redacted. It is the operator's own data on the way back to the operator.
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ContentSafetyPort } from './content-safety'

/** A stored-value match found in content the original tool already returned. */
export interface StoredToolResultMatch {
  toolCallId: string
  storedKeys: readonly string[]
}

export type OnStoredToolResult = (match: StoredToolResultMatch) => Promise<void> | void

/**
 * Wrap one tool so its result content is redacted before the model sees it.
 *
 * Only `content` is redacted. `details` is display/telemetry metadata that never
 * enters the model context, and rewriting it would corrupt the structured shapes
 * renderers depend on.
 *
 * `onStoredToolResult` observes stored-value matches in the raw content after
 * `execute` has completed and before the redacted return reaches the caller —
 * the truthful post-execution audit point. Observing never changes what is
 * returned: the redaction below is the same boundary #1378 established.
 */
export function wrapToolWithOutputRedaction<T extends ToolDefinition>(
  tool: T,
  safety: ContentSafetyPort,
  onStoredToolResult?: OnStoredToolResult
): T {
  const execute = tool.execute.bind(tool) as (...args: unknown[]) => Promise<{ content?: unknown[] }>
  return {
    ...tool,
    execute: async (...args: unknown[]) => {
      const result = await execute(...args)
      if (!result?.content?.length) return result
      const inspected = safety.redactWithStoredKeys(result.content)
      if (inspected.storedKeys.length > 0 && onStoredToolResult) {
        await onStoredToolResult({ toolCallId: args[0] as string, storedKeys: inspected.storedKeys })
      }
      return { ...result, content: inspected.value }
    },
  } as unknown as T
}

/** Wrap every registered tool. Applied once at session construction. */
export function wrapToolsWithOutputRedaction<T extends ToolDefinition>(
  tools: readonly T[],
  safety: ContentSafetyPort,
  onStoredToolResult?: OnStoredToolResult
): T[] {
  return tools.map((tool) => wrapToolWithOutputRedaction(tool, safety, onStoredToolResult))
}
