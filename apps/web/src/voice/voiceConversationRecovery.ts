import type { RealtimeTransport } from './realtimeTransport'
import type { VoiceTranscriptEntry } from './types'

/**
 * Restore recent spoken context to a new connection without rerunning tools or requesting speech.
 * Entries whose IDs are still queued as pending model input (for example task updates awaiting
 * catch-up) are excluded so the same update is never injected twice.
 */
export function restoreVoiceConversation(
  transport: Pick<RealtimeTransport, 'sendEvent'>,
  history: VoiceTranscriptEntry[],
  excludeIds: ReadonlySet<string> = new Set()
): void {
  const messages = history
    .filter(
      (entry) =>
        entry.final &&
        !entry.interrupted &&
        !(entry.id && excludeIds.has(entry.id)) &&
        (entry.role === 'tool' ? Boolean(entry.toolResult) : Boolean(entry.text.trim()))
    )
    .slice(-24)
  for (const entry of messages) {
    transport.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: entry.role === 'tool' ? 'user' : entry.role,
        status: 'completed',
        content: [
          {
            type: entry.role === 'assistant' ? 'output_text' : 'input_text',
            text:
              entry.role === 'tool'
                ? `[Previously completed tool result; context only, do not rerun: ${JSON.stringify({ tool: entry.toolName, result: entry.toolResult?.slice(-4000) })}]`
                : entry.text.slice(-4000),
          },
        ],
      },
    })
  }
}
