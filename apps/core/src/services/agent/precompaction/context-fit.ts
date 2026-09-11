/**
 * Pure helpers for making compaction's summarize request FIT a summarizer
 * model's context window (#625). When a session's context was built under a
 * large-window model (e.g. glm-5.2, 1M) and compaction must run on a
 * smaller-window model (e.g. gpt-5.5, 272k), the serialized summarize request
 * itself can exceed the summarizer's window: pi caps tool RESULTS at 2k chars
 * during serialization but leaves tool-call arguments (full Write/Edit file
 * contents), assistant text, and thinking uncapped. These helpers estimate the
 * request size with pi's own serializer and clamp the preparation until it
 * fits a given budget.
 */
import { compact, convertToLlm, serializeConversation } from '@earendil-works/pi-coding-agent'

export type CompactionPreparation = Parameters<typeof compact>[0]

/**
 * Estimate the token size of the summarize request pi's `compact()` will build
 * from this preparation. Mirrors pi's own pipeline (`convertToLlm` then
 * `serializeConversation`) so the estimate tracks the actual serialization
 * pi's `generateSummary` sends — including its own tool-result truncation and
 * the `bashExecution`/`custom`/`branchSummary`/`compactionSummary` message
 * conversions `convertToLlm` performs — with pi's chars/4 heuristic.
 */
export function estimateSummarizeTokens(preparation: CompactionPreparation): number {
  const parts = [serializeConversation(convertToLlm(preparation.messagesToSummarize))]
  if (preparation.turnPrefixMessages.length > 0) {
    parts.push(serializeConversation(convertToLlm(preparation.turnPrefixMessages)))
  }
  if (preparation.previousSummary) parts.push(preparation.previousSummary)
  return Math.ceil(parts.join('\n\n').length / 4)
}

/**
 * Input-token budget for a summarize request against `model`. Mirrors pi's
 * response sizing (`min(0.8 * reserveTokens, model.maxTokens)`), then applies
 * a 0.85 factor to absorb chars/4 estimation error and a fixed margin for the
 * summarization system prompt and scaffolding.
 */
export function summarizeInputBudget(
  model: { contextWindow: number; maxTokens: number },
  settings: { reserveTokens: number }
): number {
  const responseTokens = Math.min(
    Math.floor(0.8 * settings.reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY
  )
  return Math.max(0, Math.floor((model.contextWindow - responseTokens) * 0.85) - 4_000)
}

const TOOL_ARG_MAX_CHARS = 2_000
const THINKING_MAX_CHARS = 2_000
const TEXT_CAP_STEPS_CHARS = [20_000, 5_000, 2_000]

type PreparationMessage = CompactionPreparation['messagesToSummarize'][number]

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…[+${text.length - maxChars} chars truncated]`
}

function clampToolArgsAndThinking(message: PreparationMessage): void {
  if (message.role !== 'assistant') return
  for (const block of message.content as unknown as Array<Record<string, unknown>>) {
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      block.thinking = truncateText(block.thinking, THINKING_MAX_CHARS)
    } else if (block.type === 'toolCall' && block.arguments && typeof block.arguments === 'object') {
      const args = block.arguments as Record<string, unknown>
      for (const [key, value] of Object.entries(args)) {
        const serialized = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
        if (serialized.length > TOOL_ARG_MAX_CHARS) args[key] = truncateText(serialized, TOOL_ARG_MAX_CHARS)
      }
    }
  }
}

function clampTextBlocks(message: PreparationMessage, maxChars: number): void {
  if (message.role === 'user') {
    if (typeof message.content === 'string') {
      message.content = truncateText(message.content, maxChars)
      return
    }
    for (const block of message.content as unknown as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') block.text = truncateText(block.text, maxChars)
    }
    return
  }
  if (message.role === 'assistant') {
    for (const block of message.content as unknown as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') block.text = truncateText(block.text, maxChars)
    }
    return
  }
  if (message.role === 'bashExecution') {
    const bash = message as unknown as { output: string }
    if (typeof bash.output === 'string') bash.output = truncateText(bash.output, maxChars)
    return
  }
  if (message.role === 'custom') {
    const custom = message as unknown as { content: string | Array<Record<string, unknown>> }
    if (typeof custom.content === 'string') {
      custom.content = truncateText(custom.content, maxChars)
    } else if (Array.isArray(custom.content)) {
      for (const block of custom.content) {
        if (block.type === 'text' && typeof block.text === 'string') block.text = truncateText(block.text, maxChars)
      }
    }
  }
}

/**
 * Shrink a preparation until its summarize request fits `budgetTokens`.
 * Escalating passes: (1) clamp tool-call arguments and thinking to 2k chars
 * (the same treatment pi gives tool results); (2) tighten text blocks
 * (user/assistant text, bashExecution output, custom message content) through
 * 20k → 5k → 2k chars; (3) drop the oldest half of the to-summarize messages
 * until it fits, prepending a note so the summary records the omission; (4)
 * last resort, truncate `previousSummary` itself to 2k chars if it is still
 * pushing the estimate over budget. `firstKeptEntryId`/kept context are never
 * touched — this only shapes the summarizer's INPUT. Returns the original
 * object when it already fits.
 */
export function clampPreparationForBudget(
  preparation: CompactionPreparation,
  budgetTokens: number
): CompactionPreparation {
  if (estimateSummarizeTokens(preparation) <= budgetTokens) return preparation

  const clamped: CompactionPreparation = structuredClone(preparation)
  const allMessages = () => [...clamped.messagesToSummarize, ...clamped.turnPrefixMessages]

  for (const message of allMessages()) clampToolArgsAndThinking(message)
  if (estimateSummarizeTokens(clamped) <= budgetTokens) return clamped

  for (const cap of TEXT_CAP_STEPS_CHARS) {
    for (const message of allMessages()) clampTextBlocks(message, cap)
    if (estimateSummarizeTokens(clamped) <= budgetTokens) return clamped
  }

  // Reserve room for the omission note below so appending it cannot push the
  // result back over budget at a tight boundary.
  const NOTE_RESERVE_TOKENS = 64
  let dropped = 0
  while (
    estimateSummarizeTokens(clamped) > budgetTokens - NOTE_RESERVE_TOKENS &&
    clamped.messagesToSummarize.length > 1
  ) {
    const drop = Math.ceil(clamped.messagesToSummarize.length / 2)
    clamped.messagesToSummarize.splice(0, drop)
    dropped += drop
  }
  if (dropped > 0) {
    clamped.messagesToSummarize.unshift({
      role: 'user',
      content: `[Note: the ${dropped} earliest messages were omitted from this summary because they exceeded the summarizer's context budget.]`,
      timestamp: 0,
    } as PreparationMessage)
  }
  if (estimateSummarizeTokens(clamped) > budgetTokens && clamped.previousSummary) {
    clamped.previousSummary = truncateText(clamped.previousSummary, TEXT_CAP_STEPS_CHARS[2] /* 2000 */)
  }
  return clamped
}
