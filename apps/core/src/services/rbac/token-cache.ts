const tokenCache = new Map<string, string>()

export function cacheAgentToken(agentId: string, token: string): void {
  tokenCache.set(agentId, token)
}

export function getCachedAgentToken(agentId: string): string | undefined {
  return tokenCache.get(agentId)
}

export function removeCachedAgentToken(agentId: string): void {
  tokenCache.delete(agentId)
}
