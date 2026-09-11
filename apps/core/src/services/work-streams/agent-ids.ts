export interface WorkStreamAgentBinding {
  assigneeAgentId: string | null
  agentIds: string[] | null
}

export function collectWorkStreamAgentIds(stream: WorkStreamAgentBinding): string[] {
  const ids = new Set<string>()
  if (stream.assigneeAgentId) ids.add(stream.assigneeAgentId)
  for (const id of stream.agentIds ?? []) ids.add(id)
  return [...ids]
}
