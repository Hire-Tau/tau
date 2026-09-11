/**
 * S3 Sync Adapter
 *
 * Handles S3 operations for memory sync:
 * - Pull objects from S3 bucket to local memory
 * - Push local changes to S3
 * - Uses etag/mtime comparison for efficient sync
 *
 * Supports custom endpoints for S3-compatible services (MinIO, etc.)
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join, dirname, relative } from 'path'
import { createHash } from 'crypto'
import { ensureSquadMemoryPath } from '../paths'
import type { S3SyncConfig, SyncAdapter, SyncPullResult, SyncPushResult } from './types'
import { createLogger } from '../../../lib/infra/logger'

const log = createLogger('s3-sync')

interface S3ObjectMetadata {
  key: string
  etag: string
  lastModified: Date
  size: number
}

interface LocalFileMetadata {
  path: string
  hash: string
  mtime: Date
  size: number
}

interface S3Status extends Record<string, unknown> {
  initialized: boolean
  bucket: string
  pathPrefix: string
  objectCount?: number
  lastSyncState?: Record<string, string> // path -> etag mapping
}

// Sync state file location
const SYNC_STATE_FILE = '_system/s3-sync-state.json'

export class S3Adapter implements SyncAdapter {
  private squadId: string
  private config: S3SyncConfig
  private memoryPath: string
  private client: S3Client

  constructor(squadId: string, config: S3SyncConfig) {
    this.squadId = squadId
    this.config = config
    this.memoryPath = ensureSquadMemoryPath(squadId)

    // Initialize S3 client
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      // Credentials are loaded from environment or IAM role by default
      // For explicit credentials, they would be loaded from credentialsRef
      forcePathStyle: !!config.endpoint, // Use path-style for custom endpoints (MinIO, etc.)
    })
  }

  /**
   * Validate S3 config before use.
   */
  static validateConfig(config: S3SyncConfig): void {
    if (!config.bucket || config.bucket.trim() === '') {
      throw new Error('Bucket name is required')
    }

    if (!config.region || config.region.trim() === '') {
      throw new Error('Region is required')
    }

    // Validate bucket name (AWS rules)
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) {
      throw new Error('Invalid bucket name format')
    }
  }

  /**
   * Check if sync is initialized (has sync state).
   */
  async isInitialized(): Promise<boolean> {
    const statePath = join(this.memoryPath, SYNC_STATE_FILE)
    return existsSync(statePath)
  }

  /**
   * Initialize the S3 sync state.
   */
  async initialize(): Promise<{ success: boolean; error?: string }> {
    try {
      // Verify bucket access
      await this.client.send(
        new HeadBucketCommand({
          Bucket: this.config.bucket,
        })
      )

      // Create sync state directory
      const stateDir = dirname(join(this.memoryPath, SYNC_STATE_FILE))
      mkdirSync(stateDir, { recursive: true })

      // Initialize empty sync state
      const syncState = {
        lastSync: null,
        objects: {},
      }

      writeFileSync(join(this.memoryPath, SYNC_STATE_FILE), JSON.stringify(syncState, null, 2))

      return { success: true }
    } catch (e) {
      const error = e as Error
      return { success: false, error: error.message }
    }
  }

  /**
   * Pull changes from S3.
   */
  async pull(): Promise<SyncPullResult> {
    try {
      // Initialize if needed
      if (!(await this.isInitialized())) {
        const initResult = await this.initialize()
        if (!initResult.success) {
          return { success: false, error: initResult.error }
        }
      }

      // Load current sync state
      const syncState = this.loadSyncState()

      // List objects in S3 bucket with prefix
      const remoteObjects = await this.listObjects()

      let filesChanged = 0
      const conflicts: string[] = []

      // Compare and download changed files
      for (const obj of remoteObjects) {
        const localPath = this.s3KeyToLocalPath(obj.key)
        const fullPath = join(this.memoryPath, localPath)
        const previousEtag = syncState.objects[localPath]

        // Check if file exists locally
        if (existsSync(fullPath)) {
          const localHash = this.computeFileHash(fullPath)

          // Check for conflict: both changed since last sync
          if (previousEtag && previousEtag !== obj.etag && localHash !== previousEtag) {
            conflicts.push(`/memory/${localPath}`)
            continue
          }

          // Skip if unchanged (compare without quotes around etag)
          const cleanEtag = obj.etag.replace(/"/g, '')
          if (localHash === cleanEtag) {
            continue
          }
        }

        // Download file
        const content = await this.downloadObject(obj.key)
        if (content !== null) {
          mkdirSync(dirname(fullPath), { recursive: true })
          writeFileSync(fullPath, content)
          syncState.objects[localPath] = obj.etag.replace(/"/g, '')
          filesChanged++
        }
      }

      // Update sync state
      syncState.lastSync = new Date().toISOString()
      this.saveSyncState(syncState)

      return { success: true, filesChanged, conflicts }
    } catch (e) {
      const error = e as Error
      return { success: false, error: error.message }
    }
  }

  /**
   * Push local changes to S3.
   */
  async push(): Promise<SyncPushResult> {
    try {
      if (!(await this.isInitialized())) {
        return { success: false, error: 'S3 sync not initialized' }
      }

      const syncState = this.loadSyncState()
      const localFiles = this.listLocalFiles()
      let filesPushed = 0

      for (const file of localFiles) {
        const previousHash = syncState.objects[file.path]

        // Skip unchanged files
        if (previousHash === file.hash) {
          continue
        }

        // Upload file
        const s3Key = this.localPathToS3Key(file.path)
        const content = readFileSync(join(this.memoryPath, file.path))
        const uploaded = await this.uploadObject(s3Key, content)

        if (uploaded) {
          syncState.objects[file.path] = file.hash
          filesPushed++
        }
      }

      // Update sync state
      syncState.lastSync = new Date().toISOString()
      this.saveSyncState(syncState)

      return { success: true, filesPushed }
    } catch (e) {
      const error = e as Error
      return { success: false, error: error.message }
    }
  }

  /**
   * Get S3 sync status.
   */
  async getStatus(): Promise<S3Status> {
    const status: S3Status = {
      initialized: await this.isInitialized(),
      bucket: this.config.bucket,
      pathPrefix: this.config.pathPrefix || '',
    }

    if (status.initialized) {
      const syncState = this.loadSyncState()
      status.objectCount = Object.keys(syncState.objects).length
      status.lastSyncState = syncState.objects
    }

    return status
  }

  // --- Helper Methods ---

  /**
   * Convert S3 key to local path.
   */
  private s3KeyToLocalPath(key: string): string {
    const prefix = this.config.pathPrefix || ''
    if (key.startsWith(prefix)) {
      return key.slice(prefix.length)
    }
    return key
  }

  /**
   * Convert local path to S3 key.
   */
  private localPathToS3Key(localPath: string): string {
    const prefix = this.config.pathPrefix || ''
    return prefix + localPath
  }

  /**
   * Load sync state from file.
   */
  private loadSyncState(): { lastSync: string | null; objects: Record<string, string> } {
    const statePath = join(this.memoryPath, SYNC_STATE_FILE)
    if (existsSync(statePath)) {
      return JSON.parse(readFileSync(statePath, 'utf-8'))
    }
    return { lastSync: null, objects: {} }
  }

  /**
   * Save sync state to file.
   */
  private saveSyncState(state: { lastSync: string | null; objects: Record<string, string> }): void {
    const statePath = join(this.memoryPath, SYNC_STATE_FILE)
    const stateDir = dirname(statePath)
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(statePath, JSON.stringify(state, null, 2))
  }

  /**
   * Compute MD5 hash of a file (matches S3 ETag for non-multipart uploads).
   */
  private computeFileHash(filePath: string): string {
    const content = readFileSync(filePath)
    return createHash('md5').update(content).digest('hex')
  }

  /**
   * List all markdown files in the memory directory.
   */
  private listLocalFiles(): LocalFileMetadata[] {
    const files: LocalFileMetadata[] = []

    const walk = (dir: string) => {
      if (!existsSync(dir)) return

      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === '_system') continue

        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(fullPath)
        } else if (entry.name.endsWith('.md')) {
          const stat = statSync(fullPath)
          const relativePath = relative(this.memoryPath, fullPath)
          files.push({
            path: relativePath,
            hash: this.computeFileHash(fullPath),
            mtime: stat.mtime,
            size: stat.size,
          })
        }
      }
    }

    walk(this.memoryPath)
    return files
  }

  /**
   * List objects in S3 bucket with the configured prefix.
   */
  private async listObjects(): Promise<S3ObjectMetadata[]> {
    const objects: S3ObjectMetadata[] = []
    let continuationToken: string | undefined

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: this.config.pathPrefix || '',
          ContinuationToken: continuationToken,
        })
      )

      if (response.Contents) {
        for (const obj of response.Contents) {
          // Only include markdown files
          if (obj.Key && obj.Key.endsWith('.md')) {
            objects.push({
              key: obj.Key,
              etag: obj.ETag || '',
              lastModified: obj.LastModified || new Date(),
              size: obj.Size || 0,
            })
          }
        }
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
    } while (continuationToken)

    return objects
  }

  /**
   * Download an object from S3.
   */
  private async downloadObject(key: string): Promise<Buffer | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        })
      )

      if (response.Body) {
        // Convert readable stream to buffer
        const chunks: Uint8Array[] = []
        const reader = response.Body as AsyncIterable<Uint8Array>
        for await (const chunk of reader) {
          chunks.push(chunk)
        }
        return Buffer.concat(chunks)
      }

      return null
    } catch (e) {
      log.error(`Failed to download ${key}:`, e)
      return null
    }
  }

  /**
   * Upload an object to S3.
   */
  private async uploadObject(key: string, content: Buffer): Promise<boolean> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: content,
          ContentType: 'text/markdown',
        })
      )
      return true
    } catch (e) {
      log.error(`Failed to upload ${key}:`, e)
      return false
    }
  }
}
