/** Read-only, approximate allocated-byte accounting for VM sandbox machines. */
export interface StorageFolder {
  name: string
  path: string
  /** Measured allocation, or null when no part of this directory was measured. */
  bytes: number | null
  status: 'available' | 'partial' | 'unavailable'
  children: StorageFolder[]
}

export interface StorageSquad {
  id: string
  name: string
  bytes: number | null
  status: 'available' | 'partial' | 'unavailable'
  folders: StorageFolder[]
}

export interface StorageMachine {
  id: string
  name: string
  status: 'available' | 'partial' | 'unavailable'
  usedBytes: number | null
  totalBytes: number | null
  squads: StorageSquad[]
  unattributedBytes: number | null
  diagnostics?: {
    exitCode: number | null
    reasons: Array<
      | 'scan_timeout'
      | 'permission_denied'
      | 'scan_failed'
      | 'incomplete_output'
      | 'missing_home_totals'
      | 'disk_usage_unavailable'
      | 'ssh_timeout'
      | 'ssh_failed'
      | 'machine_not_ready'
    >
    expectedHomes: number
    measuredHomes: number
    missingHomes: string[]
  }
}

export interface StorageSnapshot {
  monitoring?: StorageMonitoring
  warnings?: StorageWarning[]
  supported: boolean
  scanning: boolean
  scannedAt: string | null
  error: string | null
  machines: StorageMachine[]
}

export interface StorageWarning {
  machineId: string
  machineName: string
  percent: number
  threshold: number
  measuredAt: string
  stale: boolean
}

export interface StorageMonitoring {
  intervalHours: number
  alertsEnabled: boolean
  thresholds: number[]
  nextScanAt: string | null
}

export type StorageStatus = Pick<StorageSnapshot, 'supported' | 'scanning' | 'scannedAt' | 'error'> & {
  monitoring: StorageMonitoring
  warnings: StorageWarning[]
}
