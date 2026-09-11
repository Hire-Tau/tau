export const HUMAN_FALLBACK_MS = 15 * 60_000

export type FleetIncidentAudience = 'manager' | 'human'
export type ManagerAlertDisposition = 'none' | 'deliver' | 'skip'

export interface FleetAlertAudiencePlan {
  manager: ManagerAlertDisposition
  humanDelayMs: number
}

const MANAGER_FIRST_SANDBOX_REASONS = new Set(['devbox_unavailable', 'bashrc_unavailable'])

export function planSandboxAlert(reasons: readonly string[], hasValidManager: boolean): FleetAlertAudiencePlan {
  if (!hasValidManager) return { manager: 'skip', humanDelayMs: 0 }

  const managerOnly = reasons.length > 0 && reasons.every((reason) => MANAGER_FIRST_SANDBOX_REASONS.has(reason))
  return { manager: 'deliver', humanDelayMs: managerOnly ? HUMAN_FALLBACK_MS : 0 }
}

export function planFleetAlert(input: {
  kind: 'provider_unhealthy' | 'squad_dead_fleet'
  causeCode: string
  hasValidManager: boolean
}): FleetAlertAudiencePlan {
  if (input.kind === 'provider_unhealthy') return { manager: 'none', humanDelayMs: 0 }
  return { manager: 'deliver', humanDelayMs: HUMAN_FALLBACK_MS }
}
