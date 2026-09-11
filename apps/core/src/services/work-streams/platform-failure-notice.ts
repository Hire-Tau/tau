import { and, arrayContains, eq, or } from 'drizzle-orm'
import { db } from '../../db'
import { executions, workStreams } from '../../db/schema'
import { InboxMessage } from '../../entities/InboxMessage'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { listOpenWaitsForStreams } from './waits'

const log = createLogger('work-stream-platform-failure-notice')

/** The additive payload fields execution.failed may carry (older emit sites omit them). */
export interface PlatformFailureNoticeEvent {
  executionId: string
  agentId: string
  status?: string
  failureClass?: string | null
  failureReason?: string | null
}

let unsubscribe: (() => void) | null = null

/**
 * Subscribe `execution.failed` to the exactly-once owner notice. The event
 * fires AFTER the terminal transaction commits (no locks held), so the
 * global-pool `InboxMessage.sendOnce` inside is safe. Registered in the same
 * worker startup path as the continuation event handlers.
 */
export function registerWorkStreamPlatformFailureNoticeHandlers(): void {
  if (unsubscribe) return
  unsubscribe = eventEmitter.on('execution.failed', (payload) => {
    void notifyWorkStreamOwnersOfPlatformRefusal(payload).catch((error) =>
      log.error('Failed to notify work-stream owner of platform refusal', {
        executionId: payload.executionId,
        agentId: payload.agentId,
        error,
      })
    )
  })
}

/** Test seam: detach the listener. */
export function unregisterWorkStreamPlatformFailureNoticeHandlersForTests(): void {
  unsubscribe?.()
  unsubscribe = null
}

/** Longest stream-title fragment embedded in the bounded notice text. */
const TITLE_LIMIT = 80

/**
 * Notify the owner of every affected active, wait-free work stream exactly
 * once when an execution failed as a pre-tool platform refusal. Returns the
 * number of notices sent (existing or new).
 *
 * Content is a fixed sanitized template: stream id/title, execution id,
 * failure class + reason code, and occurrence time. Never prompt bodies, tool
 * arguments, environments, process data, secrets, or the raw error text.
 */
export async function notifyWorkStreamOwnersOfPlatformRefusal(event: PlatformFailureNoticeEvent): Promise<number> {
  // Authoritative re-read: legacy emit sites carry no class fields, and the
  // row — not the event — is the durable classification record.
  const [execution] = await db
    .select({
      id: executions.id,
      agentId: executions.agentId,
      status: executions.status,
      failureClass: executions.failureClass,
      failureReason: executions.failureReason,
      endedAt: executions.endedAt,
    })
    .from(executions)
    .where(eq(executions.id, event.executionId))
  if (!execution || execution.status !== 'failed' || execution.failureClass !== 'platform_pre_tool_refusal') return 0

  const candidates = await db
    .select({
      id: workStreams.id,
      title: workStreams.title,
      squadId: workStreams.squadId,
      ownerAgentId: workStreams.ownerAgentId,
    })
    .from(workStreams)
    .where(
      and(
        eq(workStreams.status, 'active'),
        or(eq(workStreams.assigneeAgentId, execution.agentId), arrayContains(workStreams.agentIds, [execution.agentId]))
      )
    )
  if (candidates.length === 0) return 0

  // A stream with an open wait is already actionable through that wait; its
  // owner does not need an interruption about a concurrent platform refusal.
  const openWaits = await listOpenWaitsForStreams(candidates.map((stream) => stream.id))

  let notified = 0
  for (const stream of candidates) {
    if (!stream.ownerAgentId) continue // unowned streams have no one to notify
    if ((openWaits.get(stream.id)?.length ?? 0) > 0) continue

    const occurredAt = (execution.endedAt ?? new Date()).toISOString()
    const title = stream.title.length > TITLE_LIMIT ? `${stream.title.slice(0, TITLE_LIMIT)}…` : stream.title
    const failureReason = execution.failureReason ?? 'unknown'
    const content = [
      `Work stream "${title}" (${stream.id}) was refused by the platform before its assigned agent produced any output.`,
      `Execution ${execution.id} terminally failed with failure class ${execution.failureClass} (reason code: ${failureReason}).`,
      `Occurred at: ${occurredAt}.`,
      'The stream remains admitted but is not progressing. Park and re-admit it, or take corrective action.',
    ].join('\n')

    try {
      await InboxMessage.sendOnce(
        {
          recipientType: 'agent',
          recipientId: stream.ownerAgentId,
          senderType: 'system',
          wakeEligible: true,
          subject: `Work stream execution failed: ${title}`,
          content,
          metadata: {
            workStreamId: stream.id,
            squadId: stream.squadId,
            executionId: execution.id,
            failureClass: execution.failureClass,
            failureReason: execution.failureReason,
            occurredAt,
            source: 'work-stream-platform-failure',
          },
        },
        // One durable notice per failure episode per stream.
        `ws-platform-failure:${execution.id}:${stream.id}`
      )
      notified += 1
    } catch (error) {
      log.error('Failed to send work-stream platform failure notice', {
        workStreamId: stream.id,
        executionId: execution.id,
        error,
      })
    }
  }
  return notified
}
