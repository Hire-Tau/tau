export type { TurnContext, TurnHook, TurnHookResult, RegisteredHook, HaltUpdates } from './types'
export { turnHooks } from './registry'
export { inboxWakeHook, INBOX_WAKE_HOOK_PRIORITY } from './inbox-wake-hook'

import { turnHooks } from './registry'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('hooks')

/**
 * Register all built-in turn hooks.
 * Called during worker startup.
 */
export function registerBuiltinHooks(): void {
  // The blocking ask_human hook was removed — agents ask via the async ask_human tool
  // (agent_questions), which doesn't halt. inboxWakeHook is intentionally not registered: inbox
  // delivery happens at send time via Agent.sendMessage (explicit steer/follow-up) to avoid
  // turn-completion delivery races. Kept exported for manual recovery/tests.
  log.info('Turn hooks registered:', turnHooks.list().join(', ') || '(none)')
}
