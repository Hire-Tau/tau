/**
 * Memory Sync Types
 *
 * Shared types for Git and S3 sync adapters.
 */

// --- Configuration Types ---

export interface GitSyncConfig {
  type: 'git'
  repoUrl: string
  branch: string
  pathPrefix?: string
  sshKeyName: string
  autoPull: boolean
  autoPush: boolean
  webhookSecret?: string
}

export interface S3SyncConfig {
  type: 's3'
  bucket: string
  region: string
  endpoint?: string
  pathPrefix?: string
  credentialsRef: string
  autoPull: boolean
  autoPush: boolean
}

export type SyncProviderConfig = GitSyncConfig | S3SyncConfig

export interface MemorySyncConfig {
  providers: SyncProviderConfig[]
  conflictPolicy: 'manual' | 'last_write_wins'
  pushDebounceSeconds?: number
  pullIntervalMinutes?: number
  state?: {
    lastPull?: string // ISO date string
    lastPush?: string // ISO date string
    lastError?: string | null
  }
}

export interface MemoryConfig {
  enabled: boolean
  embeddingModel?: string
  sync?: MemorySyncConfig
}

// --- Result Types ---

export interface SyncPullResult {
  success: boolean
  filesChanged?: number
  conflicts?: string[]
  error?: string
}

export interface SyncPushResult {
  success: boolean
  filesPushed?: number
  error?: string
}

export interface SyncProviderStatus {
  type: 'git' | 's3'
  initialized: boolean
  lastPull: Date | null
  lastPush: Date | null
  error?: string
}

export interface SyncStatus {
  enabled: boolean
  providers: SyncProviderStatus[]
  lastPull: Date | null
  lastPush: Date | null
  error?: string
}

// --- Adapter Interface ---

export interface SyncAdapter {
  /**
   * Pull changes from remote.
   */
  pull(): Promise<SyncPullResult>

  /**
   * Push local changes to remote.
   */
  push(): Promise<SyncPushResult>

  /**
   * Check if the adapter is initialized (e.g., repo cloned, bucket accessible).
   */
  isInitialized(): Promise<boolean>

  /**
   * Get adapter status.
   */
  getStatus(): Promise<Record<string, unknown>>

  /**
   * Initialize the adapter (e.g., clone repo, verify bucket access).
   */
  initialize(): Promise<{ success: boolean; error?: string }>
}
