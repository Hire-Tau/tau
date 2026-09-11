import type { TurnHook, TurnHookResult } from './types'
import { deliverInboxMessagesToAgent } from '../inbox/inboxDelivery'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('hooks')

/**
 * Turn hook that checks for unread inbox messages that have not yet been
 * delivered in an execution prompt. Messages remain unread until the agent
 * explicitly marks them read, but each message is only injected once.
 */
export const inboxWakeHook: TurnHook = async (ctx): Promise<TurnHookResult> => {
  try {
    await deliverInboxMessagesToAgent(ctx.agentId)
    return { action: 'continue' }
  } catch (error) {
    log.error(`inbox-wake: Failed to check inbox for agent ${ctx.agentId.slice(0, 8)}:`, error)
    return { action: 'continue' }
  }
}

/** Priority for inbox-wake hook (runs after ask-human) */
export const INBOX_WAKE_HOOK_PRIORITY = 20
