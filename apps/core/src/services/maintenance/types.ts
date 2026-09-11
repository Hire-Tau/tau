export interface MaintenanceSnapshot {
  effective: boolean
  phase: 'active' | 'pausing' | 'paused'
  generation: number
  quiescedGeneration: number
  adminHold: { active: boolean; reason: string | null; heldAt: string | null; heldBy: string | null }
  platformLease: {
    active: boolean
    leaseId: string | null
    holder: string | null
    acquiredAt: string | null
    expiresAt: string | null
  }
}
