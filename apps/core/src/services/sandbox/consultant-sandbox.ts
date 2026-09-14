/** Consultants in one squad share a runtime, never across squads. */
export const CONSULTANT_SANDBOX_PREFIX = 'consultants_'

export function consultantSandboxId(squadId: string): string {
  return `${CONSULTANT_SANDBOX_PREFIX}${squadId}`
}

export function consultantSandboxSquadId(sandboxId: string): string | null {
  return sandboxId.startsWith(CONSULTANT_SANDBOX_PREFIX)
    ? sandboxId.slice(CONSULTANT_SANDBOX_PREFIX.length) || null
    : null
}

/** Separate scratch directories prevent accidental collisions, not a security boundary. */
export function consultantScratchPath(privateRoot: string, sandboxId?: string, agentId?: string): string {
  if (!sandboxId || !consultantSandboxSquadId(sandboxId)) return privateRoot
  if (!agentId || !/^[a-zA-Z0-9-]+$/.test(agentId)) throw new Error('Shared consultant scratch requires an agent ID')
  return `${privateRoot}/conversations/${agentId}`
}
