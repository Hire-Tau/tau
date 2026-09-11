const openLiveConversations = new Map<string, number>()

export function retainLiveConversation(agentId: string): () => void {
  openLiveConversations.set(agentId, (openLiveConversations.get(agentId) ?? 0) + 1)
  return () => {
    const remaining = (openLiveConversations.get(agentId) ?? 1) - 1
    if (remaining > 0) openLiveConversations.set(agentId, remaining)
    else openLiveConversations.delete(agentId)
  }
}

export function hasLiveConversation(agentId: string): boolean {
  return (openLiveConversations.get(agentId) ?? 0) > 0
}
