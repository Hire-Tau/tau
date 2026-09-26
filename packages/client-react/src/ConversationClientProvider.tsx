import type { TauClient } from '@ficus/client-core'
import { createContext, useContext, useMemo, type ReactNode } from 'react'

export type AgentEventEntry = { event: string; data: unknown }
export type SubscribeToAgentEvents = (agentId: string, callback: (entry: AgentEventEntry) => void) => () => void

export interface ConversationEnvironment {
  client: TauClient
  subscribeToAgentEvents?: SubscribeToAgentEvents
}

const ConversationClientContext = createContext<ConversationEnvironment | null>(null)

export function ConversationClientProvider({
  client,
  subscribeToAgentEvents,
  children,
}: {
  client: TauClient
  subscribeToAgentEvents?: SubscribeToAgentEvents
  children: ReactNode
}) {
  const environment = useMemo(() => ({ client, subscribeToAgentEvents }), [client, subscribeToAgentEvents])
  return <ConversationClientContext.Provider value={environment}>{children}</ConversationClientContext.Provider>
}

/** Access the conversation environment supplied by ConversationClientProvider. Throws if missing. */
export function useConversationEnvironment(): ConversationEnvironment {
  const environment = useContext(ConversationClientContext)
  if (!environment) throw new Error('useConversationEnvironment must be used within a ConversationClientProvider')
  return environment
}

/** Access the TauClient supplied by ConversationClientProvider. Throws if missing. */
export function useConversationClient(): TauClient {
  return useConversationEnvironment().client
}
