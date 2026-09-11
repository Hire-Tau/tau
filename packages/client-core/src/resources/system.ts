import type { Transport } from '../transport'

export interface PublicMaintenanceStatus {
  effective: boolean
  phase: 'active' | 'pausing' | 'paused'
}

export function systemResource(t: Transport) {
  return {
    getPause(): Promise<PublicMaintenanceStatus> {
      return t.request('/system/pause')
    },
  }
}
