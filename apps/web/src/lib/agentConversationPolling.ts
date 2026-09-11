export const VISIBLE_AGENT_REFETCH_INTERVAL_MS = 3000

type ActiveExecutionLike = { active: boolean; status?: string } | undefined

export function getAgentConversationStatusRefetchInterval(_input: { wsConnected: boolean }): number {
  // Poll visible agent status even when the WebSocket is connected. Local-events
  // forwarding or browser WS events can be missed while the backend execution still runs
  // and completes correctly; visible conversations should self-heal without a
  // page reload.
  return VISIBLE_AGENT_REFETCH_INTERVAL_MS
}

export function getAgentConversationMessagesRefetchInterval(input: {
  activeExecution: ActiveExecutionLike
}): number | false {
  return input.activeExecution?.active ? VISIBLE_AGENT_REFETCH_INTERVAL_MS : false
}
