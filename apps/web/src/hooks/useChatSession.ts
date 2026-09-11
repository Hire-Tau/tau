import { useState, useCallback } from 'react'

/**
 * Manages a stable session key for Chat components.
 *
 * The key stays stable during streaming (when an agent is created mid-conversation)
 * but changes when the user explicitly switches agents or starts a new chat.
 *
 * This prevents React from unmounting and remounting the Chat component when
 * a new agent ID is received during streaming, which would lose the pending
 * user message and streaming state.
 */
export function useChatSession(initialAgentId?: string) {
  const [sessionKey, setSessionKey] = useState<string>(() => initialAgentId ?? `new-${Date.now()}`)

  // Switch to an existing agent (changes key → remounts Chat)
  const selectAgent = useCallback((agentId: string) => {
    setSessionKey(agentId)
  }, [])

  // Start a new chat (changes key → remounts Chat)
  const startNewChat = useCallback(() => {
    setSessionKey(`new-${Date.now()}`)
  }, [])

  // Agent created mid-stream - key intentionally stays the same
  // This is a no-op to prevent the Chat component from remounting
  const handleAgentCreated = useCallback((_agentId: string) => {
    // No-op: don't update sessionKey during streaming
  }, [])

  return { sessionKey, selectAgent, startNewChat, handleAgentCreated }
}
