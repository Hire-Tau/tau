/**
 * Memory Sync Service
 *
 * Orchestrates sync operations across Git and S3 providers.
 * Manages sync queue, debouncing, and status tracking.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../../db'
import { squads } from '../../../db/schema'
import { GitAdapter } from './GitAdapter'
import { S3Adapter } from './S3Adapter'
import { DebouncedQueue, LockManager } from '../../../lib/infra'
import { jsonbObjectOrEmpty } from '../../../db/jsonb'
import type {
  SyncStatus,
  SyncPullResult,
  SyncPushResult,
  MemoryConfig,
  SyncProviderConfig,
  GitSyncConfig,
  SyncAdapter,
  SyncProviderStatus,
} from './types'

// Re-export types for convenience
export type {
  SyncStatus,
  SyncPullResult,
  SyncPushResult,
  SyncProviderConfig,
  GitSyncConfig,
  S3SyncConfig,
} from './types'

// --- Types ---

export interface SyncServiceDeps {
  /**
   * Default push debounce in milliseconds. Defaults to 5000.
   */
  defaultPushDebounceMs?: number
}

interface SyncState {
  lastPull: Date | null
  lastPush: Date | null
  lastError: string | null
}

// --- Class ---

export class SyncService {
  private static _instance: SyncService | null = null

  private syncLock: LockManager
  private pushQueue: DebouncedQueue
  private syncStates = new Map<string, SyncState>()

  constructor(deps: SyncServiceDeps = {}) {
    this.syncLock = new LockManager()
    this.pushQueue = new DebouncedQueue({
      defaultDelayMs: deps.defaultPushDebounceMs ?? 5000,
    })
  }

  /**
   * Get the shared SyncService instance.
   */
  static instance(): SyncService {
    if (!SyncService._instance) {
      SyncService._instance = new SyncService()
    }
    return SyncService._instance
  }

  /**
   * Reset the shared instance (for testing).
   */
  static _reset(): void {
    if (SyncService._instance) {
      SyncService._instance.clearAllPendingPushes()
    }
    SyncService._instance = null
  }

  /**
   * Get memory config from squad metadata.
   */
  private async getMemoryConfig(squadId: string): Promise<MemoryConfig | null> {
    const squad = await db.query.squads.findFirst({
      where: eq(squads.id, squadId),
    })

    if (!squad) return null

    const metadata = squad.metadata as Record<string, unknown> | null
    if (!metadata?.memory) return null

    return metadata.memory as MemoryConfig
  }

  /**
   * Update sync state in memory and persist to database.
   */
  private async updateSyncState(squadId: string, update: Partial<SyncState>): Promise<void> {
    // Update in-memory cache for performance
    const current = this.syncStates.get(squadId) || {
      lastPull: null,
      lastPush: null,
      lastError: null,
    }
    this.syncStates.set(squadId, { ...current, ...update })

    // Persist to squad metadata
    const stateUpdate: Record<string, unknown> = {}
    if (update.lastPull !== undefined) stateUpdate.lastPull = update.lastPull?.toISOString() ?? null
    if (update.lastPush !== undefined) stateUpdate.lastPush = update.lastPush?.toISOString() ?? null
    if (update.lastError !== undefined) stateUpdate.lastError = update.lastError

    await db.execute(sql`
      UPDATE squads 
      SET metadata = jsonb_set(
        jsonb_set(
          jsonb_set(
            ${jsonbObjectOrEmpty(sql.raw('metadata'))},
            '{memory}',
            ${jsonbObjectOrEmpty(sql.raw(`metadata->'memory'`))},
            true
          ),
          '{memory,sync}',
          ${jsonbObjectOrEmpty(sql.raw(`metadata->'memory'->'sync'`))},
          true
        ),
        '{memory,sync,state}',
        ${jsonbObjectOrEmpty(sql.raw(`metadata->'memory'->'sync'->'state'`))} || ${JSON.stringify(stateUpdate)}::jsonb,
        true
      )
      WHERE id = ${squadId}
    `)
  }

  /**
   * Create adapter for a sync provider config.
   */
  private createAdapter(squadId: string, config: SyncProviderConfig): SyncAdapter {
    switch (config.type) {
      case 'git':
        return new GitAdapter(squadId, config)
      case 's3':
        return new S3Adapter(squadId, config)
      default:
        throw new Error(`Unknown sync provider type: ${(config as SyncProviderConfig).type}`)
    }
  }

  /**
   * Get sync status for a squad.
   */
  async getStatus(squadId: string): Promise<SyncStatus> {
    const config = await this.getMemoryConfig(squadId)

    if (!config?.enabled || !config.sync?.providers?.length) {
      return {
        enabled: false,
        providers: [],
        lastPull: null,
        lastPush: null,
      }
    }

    // Read persisted state from config, fall back to in-memory cache
    const persistedState = config.sync.state
    const memoryState = this.syncStates.get(squadId)

    const lastPull = persistedState?.lastPull ? new Date(persistedState.lastPull) : (memoryState?.lastPull ?? null)
    const lastPush = persistedState?.lastPush ? new Date(persistedState.lastPush) : (memoryState?.lastPush ?? null)
    const lastError = persistedState?.lastError ?? memoryState?.lastError ?? null

    const providers: SyncProviderStatus[] = []

    for (const providerConfig of config.sync.providers) {
      const adapter = this.createAdapter(squadId, providerConfig)
      const initialized = await adapter.isInitialized()

      providers.push({
        type: providerConfig.type,
        initialized,
        lastPull,
        lastPush,
        error: lastError || undefined,
      })
    }

    return {
      enabled: true,
      providers,
      lastPull,
      lastPush,
      error: lastError || undefined,
    }
  }

  /**
   * Pull changes from all configured sync providers.
   */
  async pull(squadId: string): Promise<SyncPullResult> {
    const config = await this.getMemoryConfig(squadId)

    if (!config?.enabled || !config.sync?.providers?.length) {
      return { success: false, error: 'Sync is not enabled for this squad' }
    }

    // Use lock to prevent concurrent syncs
    return this.syncLock.withLock(squadId, async () => {
      let totalFilesChanged = 0
      const allConflicts: string[] = []
      const errors: string[] = []

      for (const providerConfig of config.sync!.providers) {
        const adapter = this.createAdapter(squadId, providerConfig)
        const result = await adapter.pull()

        if (result.success) {
          totalFilesChanged += result.filesChanged || 0
          if (result.conflicts) {
            allConflicts.push(...result.conflicts)
          }
        } else {
          errors.push(`${providerConfig.type}: ${result.error}`)
        }
      }

      await this.updateSyncState(squadId, {
        lastPull: new Date(),
        lastError: errors.length > 0 ? errors.join('; ') : null,
      })

      if (errors.length > 0 && errors.length === config.sync!.providers.length) {
        return { success: false, error: errors.join('; ') }
      }

      return {
        success: true,
        filesChanged: totalFilesChanged,
        conflicts: allConflicts,
      }
    })
  }

  /**
   * Push changes to all configured sync providers.
   */
  async push(squadId: string): Promise<SyncPushResult> {
    const config = await this.getMemoryConfig(squadId)

    if (!config?.enabled || !config.sync?.providers?.length) {
      return { success: false, error: 'Sync is not enabled for this squad' }
    }

    // Use lock to prevent concurrent syncs
    return this.syncLock.withLock(squadId, async () => {
      let totalFilesPushed = 0
      const errors: string[] = []

      for (const providerConfig of config.sync!.providers) {
        // Skip providers with autoPush disabled
        if (!providerConfig.autoPush) continue

        const adapter = this.createAdapter(squadId, providerConfig)
        const result = await adapter.push()

        if (result.success) {
          totalFilesPushed += result.filesPushed || 0
        } else {
          errors.push(`${providerConfig.type}: ${result.error}`)
        }
      }

      await this.updateSyncState(squadId, {
        lastPush: new Date(),
        lastError: errors.length > 0 ? errors.join('; ') : null,
      })

      if (errors.length > 0) {
        return { success: false, error: errors.join('; ') }
      }

      return {
        success: true,
        filesPushed: totalFilesPushed,
      }
    })
  }

  /**
   * Schedule a debounced push operation.
   */
  schedulePush(squadId: string, debounceMs?: number): void {
    this.pushQueue.schedule(
      squadId,
      async () => {
        await this.push(squadId)
      },
      debounceMs
    )
  }

  /**
   * Initialize sync for a squad.
   */
  async initialize(squadId: string): Promise<{ success: boolean; errors?: string[] }> {
    const config = await this.getMemoryConfig(squadId)

    if (!config?.enabled || !config.sync?.providers?.length) {
      return { success: false, errors: ['Sync is not configured'] }
    }

    const errors: string[] = []

    for (const providerConfig of config.sync.providers) {
      const adapter = this.createAdapter(squadId, providerConfig)
      const result = await adapter.initialize()
      if (!result.success) {
        errors.push(`${providerConfig.type}: ${result.error}`)
      }
    }

    return {
      success: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    }
  }

  /**
   * Validate sync configuration.
   */
  validateConfig(config: SyncProviderConfig): { valid: boolean; error?: string } {
    try {
      switch (config.type) {
        case 'git':
          GitAdapter.validateConfig(config)
          break
        case 's3':
          S3Adapter.validateConfig(config)
          break
        default:
          return { valid: false, error: `Unknown provider type: ${(config as SyncProviderConfig).type}` }
      }
      return { valid: true }
    } catch (e) {
      const error = e as Error
      return { valid: false, error: error.message }
    }
  }

  /**
   * Handle webhook for sync events (e.g., GitHub push webhook).
   */
  async handleWebhook(
    squadId: string,
    provider: 'git' | 's3',
    event: string,
    rawBody: string,
    signature: string | null
  ): Promise<{ success: boolean; message?: string; code?: 'unauthorized' }> {
    const config = await this.getMemoryConfig(squadId)

    if (!config?.enabled || !config.sync?.providers?.length) {
      return { success: false, message: 'Sync not enabled' }
    }

    // Find matching provider
    const providerConfig = config.sync.providers.find((p) => p.type === provider)
    if (!providerConfig) {
      return { success: false, message: `Provider ${provider} not configured` }
    }

    // Handle Git push webhook
    if (provider === 'git' && event === 'push') {
      const gitConfig = providerConfig as GitSyncConfig
      if (gitConfig.autoPull) {
        // Fail closed: a state-changing pull must never run on an
        // unauthenticated/unverifiable webhook. Require an HMAC signature that
        // matches the per-squad webhookSecret (GitHub-style X-Hub-Signature-256).
        if (!gitConfig.webhookSecret) {
          return { success: false, code: 'unauthorized', message: 'Webhook secret not configured' }
        }
        const expected = 'sha256=' + createHmac('sha256', gitConfig.webhookSecret).update(rawBody).digest('hex')
        const provided = Buffer.from(signature ?? '')
        const expectedBuf = Buffer.from(expected)
        if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
          return { success: false, code: 'unauthorized', message: 'Invalid signature' }
        }
        const result = await this.pull(squadId)
        return {
          success: result.success,
          message: result.success ? `Pulled ${result.filesChanged} files` : result.error,
        }
      }
    }

    return { success: true, message: 'Webhook processed' }
  }

  /**
   * Cancel any pending push for a squad.
   */
  cancelPendingPush(squadId: string): boolean {
    return this.pushQueue.cancel(squadId)
  }

  /**
   * Clear all pending push timers.
   */
  clearAllPendingPushes(): void {
    this.pushQueue.clearAllPending()
  }

  /**
   * Get count of pending pushes and queued syncs.
   */
  getStats(): { pendingPushes: number; queuedSyncs: number } {
    return {
      pendingPushes: this.pushQueue.getStats().pending,
      queuedSyncs: this.syncLock.activeLockCount,
    }
  }
}
