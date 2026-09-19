/** Read-only, approximate allocated-byte accounting for VM sandbox machines. */
export interface StorageFolder {
  name: string
  bytes: number
  children: StorageFolder[]
}

export interface StorageSquad {
  id: string
  name: string
  bytes: number
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
}

export interface StorageSnapshot {
  supported: boolean
  scanning: boolean
  scannedAt: string | null
  error: string | null
  machines: StorageMachine[]
}
