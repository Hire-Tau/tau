export type SensitivityTier = 'public' | 'internal' | 'restricted' | 'confidential'

export const SENSITIVITY_TIERS: SensitivityTier[] = ['public', 'internal', 'restricted', 'confidential']

export interface GrantPolicyReadScope {
  sourceTypes?: string[]
  paths?: string[]
  sensitivity?: SensitivityTier
}

export interface GrantPolicyWriteScope {
  sourceTypes?: string[]
  paths?: string[]
}

export interface GrantPolicy {
  read?: GrantPolicyReadScope
  write?: GrantPolicyWriteScope
}

export interface SquadMemoryGrantDTO {
  id: string
  sourceSquadId: string
  granteeSquadId: string
  policy: GrantPolicy
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateSquadMemoryGrantInput {
  granteeSquadId: string
  policy: GrantPolicy
  expiresAt?: string | null
}
