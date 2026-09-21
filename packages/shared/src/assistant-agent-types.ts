/** User-owned conversational and background agents. Legacy IDs retain their storage identity. */
export const USER_ASSISTANT_AGENT_TYPES = ['system-manager', 'assistant', 'assistant-worker'] as const
export function isUserAssistantAgentType(id: string | null | undefined): boolean {
  return USER_ASSISTANT_AGENT_TYPES.some((type) => type === id)
}
