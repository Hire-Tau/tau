/**
 * SyncService Tests
 *
 * Tests for Git and S3 sync adapters and the SyncService orchestration.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { db } from '../../../db'
import { squads, memoryDocuments, memoryChunks } from '../../../db/schema'
import { eq } from 'drizzle-orm'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { ensureSquadMemoryPath } from '../paths'
import { removeSquadSsh } from '../../squad/ssh'

// Import SyncService
import { SyncService, type GitSyncConfig, type S3SyncConfig } from './SyncService'

// Import adapters
import { GitAdapter } from './GitAdapter'
import { S3Adapter } from './S3Adapter'

describe('SyncService', () => {
  describe('constructor', () => {
    it('creates service with default settings', () => {
      const service = new SyncService()
      expect(service.getStats()).toEqual({ pendingPushes: 0, queuedSyncs: 0 })
    })

    it('accepts custom debounce setting', () => {
      const service = new SyncService({ defaultPushDebounceMs: 1000 })
      expect(service.getStats()).toEqual({ pendingPushes: 0, queuedSyncs: 0 })
    })
  })

  describe('validateConfig', () => {
    const service = new SyncService()

    it('validates git config', () => {
      const validGitConfig: GitSyncConfig = {
        type: 'git',
        repoUrl: 'git@github.com:test/repo.git',
        branch: 'main',
        sshKeyName: 'deploy-key',
        autoPull: true,
        autoPush: true,
      }
      expect(service.validateConfig(validGitConfig)).toEqual({ valid: true })
    })

    it('returns error for invalid git URL', () => {
      const invalidGitConfig: GitSyncConfig = {
        type: 'git',
        repoUrl: 'not-a-url',
        branch: 'main',
        sshKeyName: 'key',
        autoPull: true,
        autoPush: true,
      }
      const result = service.validateConfig(invalidGitConfig)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Invalid git URL')
    })

    it('validates S3 config', () => {
      const validS3Config: S3SyncConfig = {
        type: 's3',
        bucket: 'test-bucket',
        region: 'us-east-1',
        credentialsRef: 'creds',
        autoPull: true,
        autoPush: true,
      }
      expect(service.validateConfig(validS3Config)).toEqual({ valid: true })
    })

    it('returns error for missing S3 bucket', () => {
      const invalidS3Config: S3SyncConfig = {
        type: 's3',
        bucket: '',
        region: 'us-east-1',
        credentialsRef: 'creds',
        autoPull: true,
        autoPush: true,
      }
      const result = service.validateConfig(invalidS3Config)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Bucket name is required')
    })
  })

  describe('schedulePush and cancelPendingPush', () => {
    let service: SyncService

    beforeEach(() => {
      service = new SyncService({ defaultPushDebounceMs: 10000 })
    })

    afterEach(() => {
      service.clearAllPendingPushes()
    })

    it('schedules a push', () => {
      service.schedulePush('squad-1')
      expect(service.getStats().pendingPushes).toBe(1)
    })

    it('cancels a pending push', () => {
      service.schedulePush('squad-1')
      expect(service.cancelPendingPush('squad-1')).toBe(true)
      expect(service.getStats().pendingPushes).toBe(0)
    })

    it('returns false when cancelling non-existent push', () => {
      expect(service.cancelPendingPush('non-existent')).toBe(false)
    })

    it('debounces rapid calls', () => {
      service.schedulePush('squad-1')
      service.schedulePush('squad-1')
      service.schedulePush('squad-1')
      expect(service.getStats().pendingPushes).toBe(1)
    })

    it('clears all pending pushes', () => {
      service.schedulePush('squad-1')
      service.schedulePush('squad-2')
      service.clearAllPendingPushes()
      expect(service.getStats().pendingPushes).toBe(0)
    })
  })
})

describe('SyncService.instance() singleton', () => {
  beforeEach(() => {
    SyncService._reset()
  })

  afterEach(() => {
    SyncService._reset()
  })

  it('returns the same instance on multiple calls', () => {
    const service1 = SyncService.instance()
    const service2 = SyncService.instance()
    expect(service1).toBe(service2)
  })

  it('returns new instance after reset', () => {
    const service1 = SyncService.instance()
    SyncService._reset()
    const service2 = SyncService.instance()
    expect(service1).not.toBe(service2)
  })
})

describe('SyncService integration', () => {
  let testSquadId: string
  let service: SyncService

  beforeEach(async () => {
    SyncService._reset()
    service = SyncService.instance()

    // Create a test squad
    const [squad] = await db
      .insert(squads)
      .values({
        name: 'Test Squad',
        purpose: 'Testing sync',
        metadata: {},
      })
      .returning()
    testSquadId = squad.id

    // Ensure memory directory exists
    const memoryPath = ensureSquadMemoryPath(testSquadId)
    mkdirSync(memoryPath, { recursive: true })
  })

  afterEach(async () => {
    SyncService._reset()

    // Clean up test data
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(squads).where(eq(squads.id, testSquadId))

    // Clean up memory directory
    const memoryPath = ensureSquadMemoryPath(testSquadId)
    if (existsSync(memoryPath)) {
      rmSync(memoryPath, { recursive: true, force: true })
    }
  })

  describe('getStatus', () => {
    it('returns disabled status when no sync config exists', async () => {
      const status = await service.getStatus(testSquadId)

      expect(status.enabled).toBe(false)
      expect(status.providers).toEqual([])
      expect(status.lastPull).toBeNull()
      expect(status.lastPush).toBeNull()
    })

    it('returns status with providers when configured', async () => {
      // Update squad with sync config
      await db
        .update(squads)
        .set({
          metadata: {
            memory: {
              enabled: true,
              sync: {
                providers: [
                  {
                    type: 'git',
                    repoUrl: 'git@github.com:test/repo.git',
                    branch: 'main',
                    sshKeyName: 'deploy-key',
                    autoPull: true,
                    autoPush: true,
                  },
                ],
                conflictPolicy: 'manual',
              },
            },
          },
        })
        .where(eq(squads.id, testSquadId))

      const status = await service.getStatus(testSquadId)

      expect(status.enabled).toBe(true)
      expect(status.providers).toHaveLength(1)
      expect(status.providers[0].type).toBe('git')
    })

    it('reads persisted sync state from squad metadata', async () => {
      const lastPullDate = new Date('2026-02-27T10:00:00Z')
      const lastPushDate = new Date('2026-02-27T11:00:00Z')

      // Configure squad with persisted state
      await db
        .update(squads)
        .set({
          metadata: {
            memory: {
              enabled: true,
              sync: {
                providers: [
                  {
                    type: 'git',
                    repoUrl: 'git@github.com:test/repo.git',
                    branch: 'main',
                    sshKeyName: 'deploy-key',
                    autoPull: true,
                    autoPush: true,
                  },
                ],
                conflictPolicy: 'manual',
                state: {
                  lastPull: lastPullDate.toISOString(),
                  lastPush: lastPushDate.toISOString(),
                  lastError: null,
                },
              },
            },
          },
        })
        .where(eq(squads.id, testSquadId))

      const status = await service.getStatus(testSquadId)

      expect(status.lastPull).toEqual(lastPullDate)
      expect(status.lastPush).toEqual(lastPushDate)
      expect(status.error).toBeUndefined()
    })
  })

  describe('pull', () => {
    it('returns error when sync is not enabled', async () => {
      const result = await service.pull(testSquadId)

      expect(result.success).toBe(false)
      expect(result.error).toContain('not enabled')
    })

    it('pulls changes from git provider when configured', async () => {
      // Configure git sync
      await db
        .update(squads)
        .set({
          metadata: {
            memory: {
              enabled: true,
              sync: {
                providers: [
                  {
                    type: 'git',
                    repoUrl: 'git@github.com:test/repo.git',
                    branch: 'main',
                    sshKeyName: 'deploy-key',
                    autoPull: true,
                    autoPush: false,
                  },
                ],
                conflictPolicy: 'manual',
              },
            },
          },
        })
        .where(eq(squads.id, testSquadId))

      // Mock the git adapter
      const mockGitPull = spyOn(GitAdapter.prototype, 'pull').mockResolvedValue({
        success: true,
        filesChanged: 2,
        conflicts: [],
      })

      const result = await service.pull(testSquadId)

      expect(mockGitPull).toHaveBeenCalled()
      expect(result.success).toBe(true)
      expect(result.filesChanged).toBe(2)

      mockGitPull.mockRestore()
    })

    it('reports conflicts when detected', async () => {
      await db
        .update(squads)
        .set({
          metadata: {
            memory: {
              enabled: true,
              sync: {
                providers: [
                  {
                    type: 'git',
                    repoUrl: 'git@github.com:test/repo.git',
                    branch: 'main',
                    sshKeyName: 'deploy-key',
                    autoPull: true,
                    autoPush: false,
                  },
                ],
                conflictPolicy: 'manual',
              },
            },
          },
        })
        .where(eq(squads.id, testSquadId))

      const mockGitPull = spyOn(GitAdapter.prototype, 'pull').mockResolvedValue({
        success: true,
        filesChanged: 1,
        conflicts: ['/memory/decisions/auth.md'],
      })

      const result = await service.pull(testSquadId)

      expect(result.success).toBe(true)
      expect(result.conflicts).toContain('/memory/decisions/auth.md')

      mockGitPull.mockRestore()
    })
  })

  describe('push', () => {
    it('returns error when sync is not enabled', async () => {
      const result = await service.push(testSquadId)

      expect(result.success).toBe(false)
      expect(result.error).toContain('not enabled')
    })

    it('persists sync state to squad metadata after push', async () => {
      await db
        .update(squads)
        .set({
          metadata: {
            memory: {
              enabled: true,
              sync: {
                providers: [
                  {
                    type: 'git',
                    repoUrl: 'git@github.com:test/repo.git',
                    branch: 'main',
                    sshKeyName: 'deploy-key',
                    autoPull: false,
                    autoPush: true,
                  },
                ],
                conflictPolicy: 'manual',
              },
            },
          },
        })
        .where(eq(squads.id, testSquadId))

      const mockGitPush = spyOn(GitAdapter.prototype, 'push').mockResolvedValue({
        success: true,
        filesPushed: 1,
      })

      await service.push(testSquadId)

      // Verify state was persisted to database
      const squad = await db.query.squads.findFirst({
        where: eq(squads.id, testSquadId),
      })
      const metadata = squad?.metadata as Record<string, unknown>
      const syncState = (metadata?.memory as Record<string, unknown>)?.sync as Record<string, unknown>
      const state = syncState?.state as Record<string, unknown>

      expect(state).toBeDefined()
      expect(state.lastPush).toBeDefined()
      expect(typeof state.lastPush).toBe('string')
      // Verify it's a valid ISO date string
      const lastPushStr = state.lastPush as string
      expect(new Date(lastPushStr).toISOString()).toBe(lastPushStr)

      mockGitPush.mockRestore()
    })

    it('pushes changes to git provider when configured', async () => {
      await db
        .update(squads)
        .set({
          metadata: {
            memory: {
              enabled: true,
              sync: {
                providers: [
                  {
                    type: 'git',
                    repoUrl: 'git@github.com:test/repo.git',
                    branch: 'main',
                    sshKeyName: 'deploy-key',
                    autoPull: false,
                    autoPush: true,
                  },
                ],
                conflictPolicy: 'manual',
              },
            },
          },
        })
        .where(eq(squads.id, testSquadId))

      // Create a test file to push
      const memoryPath = ensureSquadMemoryPath(testSquadId)
      writeFileSync(join(memoryPath, 'test.md'), '# Test\n\nContent here.')

      const mockGitPush = spyOn(GitAdapter.prototype, 'push').mockResolvedValue({
        success: true,
        filesPushed: 1,
      })

      const result = await service.push(testSquadId)

      expect(mockGitPush).toHaveBeenCalled()
      expect(result.success).toBe(true)

      mockGitPush.mockRestore()
    })
  })
})

describe('GitAdapter', () => {
  let adapter: GitAdapter
  let testSquadId: string
  let memoryPath: string

  const gitConfig: GitSyncConfig = {
    type: 'git',
    repoUrl: 'git@github.com:test/repo.git',
    branch: 'main',
    sshKeyName: 'deploy-key',
    autoPull: true,
    autoPush: true,
    pathPrefix: '',
  }

  beforeEach(async () => {
    // Create a test squad
    const [squad] = await db
      .insert(squads)
      .values({
        name: 'Git Test Squad',
        purpose: 'Testing git sync',
        metadata: {},
      })
      .returning()
    testSquadId = squad.id
    memoryPath = ensureSquadMemoryPath(testSquadId)
    mkdirSync(memoryPath, { recursive: true })

    adapter = new GitAdapter(testSquadId, gitConfig)
  })

  afterEach(async () => {
    await db.delete(squads).where(eq(squads.id, testSquadId))
    if (existsSync(memoryPath)) {
      rmSync(memoryPath, { recursive: true, force: true })
    }
    await removeSquadSsh(testSquadId)
  })

  describe('isInitialized', () => {
    it('returns false when .git directory does not exist', async () => {
      const initialized = await adapter.isInitialized()
      expect(initialized).toBe(false)
    })

    it('returns true when .git directory exists', async () => {
      mkdirSync(join(memoryPath, '.git'), { recursive: true })
      const initialized = await adapter.isInitialized()
      expect(initialized).toBe(true)
    })
  })

  describe('validateConfig', () => {
    it('rejects invalid git URL', () => {
      const invalidConfig = { ...gitConfig, repoUrl: 'not-a-url' }
      expect(() => GitAdapter.validateConfig(invalidConfig)).toThrow('Invalid git URL')
    })

    it('accepts valid SSH git URL', () => {
      expect(() => GitAdapter.validateConfig(gitConfig)).not.toThrow()
    })

    it('accepts valid HTTPS git URL', () => {
      const httpsConfig = { ...gitConfig, repoUrl: 'https://github.com/test/repo.git' }
      expect(() => GitAdapter.validateConfig(httpsConfig)).not.toThrow()
    })
  })

  describe('getStatus', () => {
    it('returns not initialized status when repo not cloned', async () => {
      const status = await adapter.getStatus()
      expect(status.initialized).toBe(false)
      expect(status.branch).toBeNull()
    })
  })
})

describe('S3Adapter', () => {
  let adapter: S3Adapter
  let testSquadId: string
  let memoryPath: string

  const s3Config: S3SyncConfig = {
    type: 's3',
    bucket: 'test-bucket',
    region: 'us-east-1',
    pathPrefix: 'memory/',
    credentialsRef: 'test-creds',
    autoPull: true,
    autoPush: true,
  }

  beforeEach(async () => {
    const [squad] = await db
      .insert(squads)
      .values({
        name: 'S3 Test Squad',
        purpose: 'Testing S3 sync',
        metadata: {},
      })
      .returning()
    testSquadId = squad.id
    memoryPath = ensureSquadMemoryPath(testSquadId)
    mkdirSync(memoryPath, { recursive: true })

    adapter = new S3Adapter(testSquadId, s3Config)
  })

  afterEach(async () => {
    await db.delete(squads).where(eq(squads.id, testSquadId))
    if (existsSync(memoryPath)) {
      rmSync(memoryPath, { recursive: true, force: true })
    }
  })

  describe('validateConfig', () => {
    it('rejects missing bucket', () => {
      const invalidConfig = { ...s3Config, bucket: '' }
      expect(() => S3Adapter.validateConfig(invalidConfig)).toThrow('Bucket name is required')
    })

    it('rejects missing region', () => {
      const invalidConfig = { ...s3Config, region: '' }
      expect(() => S3Adapter.validateConfig(invalidConfig)).toThrow('Region is required')
    })

    it('accepts valid S3 config', () => {
      expect(() => S3Adapter.validateConfig(s3Config)).not.toThrow()
    })
  })

  describe('getStatus', () => {
    it('returns status for S3 sync', async () => {
      const status = await adapter.getStatus()
      expect(status.bucket).toBe('test-bucket')
      expect(status.pathPrefix).toBe('memory/')
    })
  })
})
