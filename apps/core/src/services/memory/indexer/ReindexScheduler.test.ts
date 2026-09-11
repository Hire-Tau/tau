/**
 * ReindexScheduler Tests
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test'
import { db } from '../../../db'
import { squads, memoryDocuments, memoryChunks, squadSourceConfigs } from '../../../db/schema'
import { eq } from 'drizzle-orm'
import { writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { ensureSquadMemoryPath } from '../paths'
import { ReindexScheduler } from './ReindexScheduler'
import { IndexingService } from './IndexingService'
import { FileSource } from '../sources/FileSource'
import { SquadSourceConfig } from '../../../entities/SquadSourceConfig'

/**
 * Poll a condition until it holds. Bounded by a real deadline rather than a
 * tick count so that a condition which depends on a timer (not just microtask
 * drain) cannot be declared failed simply because the immediates loop spun
 * faster than the timer.
 */
async function waitFor(condition: () => boolean, description = 'condition'): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

describe('ReindexScheduler', () => {
  describe('constructor', () => {
    it('creates scheduler with default settings', () => {
      const scheduler = new ReindexScheduler()
      expect(scheduler.getStats()).toEqual({ pending: 0, running: 0 })
    })
  })

  describe('schedule and cancel', () => {
    let scheduler: ReindexScheduler

    beforeEach(() => {
      scheduler = new ReindexScheduler({ defaultThrottleMs: 1000 })
    })

    afterEach(() => {
      scheduler.clearAllPending()
      scheduler.clearAllRunning()
    })

    it('schedules a reindex', () => {
      scheduler.schedule('squad-1', 1000)
      expect(scheduler.isPending('squad-1')).toBe(true)
      expect(scheduler.isRunning('squad-1')).toBe(false)
    })

    it('cancels a pending reindex', () => {
      scheduler.schedule('squad-1', 1000)
      expect(scheduler.cancel('squad-1')).toBe(true)
      expect(scheduler.isPending('squad-1')).toBe(false)
    })

    it('returns false when cancelling non-existent reindex', () => {
      expect(scheduler.cancel('non-existent')).toBe(false)
    })

    it('debounces rapid calls', () => {
      scheduler.schedule('squad-1', 100)
      scheduler.schedule('squad-1', 100)
      scheduler.schedule('squad-1', 100)

      expect(scheduler.getStats().pending).toBe(1)
    })

    it('schedules a follow-up reindex when already running', () => {
      scheduler.markAsRunning('squad-1')
      scheduler.schedule('squad-1', 100)

      expect(scheduler.isPending('squad-1')).toBe(true)
      expect(scheduler.isRunning('squad-1')).toBe(true)
    })
  })

  describe('clearAll methods', () => {
    let scheduler: ReindexScheduler

    beforeEach(() => {
      scheduler = new ReindexScheduler()
    })

    afterEach(() => {
      scheduler.clearAllPending()
      scheduler.clearAllRunning()
    })

    it('clearAllPending removes all pending', () => {
      scheduler.schedule('squad-1', 10000)
      scheduler.schedule('squad-2', 10000)

      expect(scheduler.getStats().pending).toBe(2)

      scheduler.clearAllPending()

      expect(scheduler.getStats().pending).toBe(0)
    })

    it('clearAllRunning removes all running flags', () => {
      scheduler.markAsRunning('squad-1')
      scheduler.markAsRunning('squad-2')

      expect(scheduler.getStats().running).toBe(2)

      scheduler.clearAllRunning()

      expect(scheduler.getStats().running).toBe(0)
    })
  })
})

describe('ReindexScheduler.instance() singleton', () => {
  beforeEach(() => {
    ReindexScheduler._reset()
  })

  afterEach(() => {
    ReindexScheduler._reset()
  })

  it('returns the same instance on multiple calls', () => {
    const scheduler1 = ReindexScheduler.instance()
    const scheduler2 = ReindexScheduler.instance()
    expect(scheduler1).toBe(scheduler2)
  })

  it('returns new instance after reset', () => {
    const scheduler1 = ReindexScheduler.instance()
    ReindexScheduler._reset()
    const scheduler2 = ReindexScheduler.instance()
    expect(scheduler1).not.toBe(scheduler2)
  })
})

describe('ReindexScheduler integration', () => {
  let testSquadId: string
  let memoryPath: string
  let scheduler: ReindexScheduler
  let mockIndexFiles: ReturnType<typeof spyOn>
  let mockIndexAll: ReturnType<typeof spyOn>

  beforeEach(async () => {
    // Reset and get fresh scheduler
    ReindexScheduler._reset()
    scheduler = ReindexScheduler.instance()

    // Mock IndexingService.instance().indexFiles
    mockIndexFiles = spyOn(IndexingService.instance(), 'indexFiles').mockResolvedValue([
      { success: true, chunksCreated: 1, linksCreated: 0 },
    ])

    mockIndexAll = spyOn(FileSource.instance(), 'indexAll').mockResolvedValue([
      { success: true, chunksCreated: 1, linksCreated: 0 },
    ])

    // Create test squad
    const [squad] = await db
      .insert(squads)
      .values({
        name: 'Test Squad',
        purpose: 'Testing reindex scheduler',
        metadata: { memory: { enabled: true } },
      })
      .returning()
    testSquadId = squad.id

    // Ensure memory path exists and create a test file
    memoryPath = ensureSquadMemoryPath(testSquadId)
    await writeFile(join(memoryPath, 'test.md'), '# Test\n\nTest content')
  })

  afterEach(async () => {
    // Clear all timers and state
    scheduler.clearAllPending()
    scheduler.clearAllRunning()

    // Restore mock
    mockIndexFiles.mockRestore()
    mockIndexAll.mockRestore()

    // Clean up test files
    try {
      await rm(memoryPath, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }

    // Clean up database
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(squadSourceConfigs).where(eq(squadSourceConfigs.squadId, testSquadId))
    await db.delete(squads).where(eq(squads.id, testSquadId))
  })

  afterAll(() => {
    ReindexScheduler._reset()
  })

  describe('schedule', () => {
    it('schedules a reindex for a squad', () => {
      scheduler.schedule(testSquadId, 100)

      expect(scheduler.isPending(testSquadId)).toBe(true)
      expect(scheduler.isRunning(testSquadId)).toBe(false)
    })

    it('executes reindex after delay', async () => {
      const reindexStarted = Promise.withResolvers<void>()
      let scheduledCallback: (() => void) | undefined
      const realSetTimeout = globalThis.setTimeout
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: Parameters<typeof setTimeout>[0],
        delay?: number,
        ...args: unknown[]
      ) => {
        if (delay !== 50 || scheduledCallback) {
          return realSetTimeout(callback, delay, ...args)
        }
        scheduledCallback = () => {
          if (typeof callback === 'function') callback(...args)
        }
        // Hand back a genuine (inert) handle. Bun timer ids are sequential
        // integers, so a fabricated id such as `1` would make a later
        // clearTimeout() cancel an unrelated timer.
        return realSetTimeout(() => {}, 0)
      }) as typeof setTimeout)
      mockIndexAll.mockImplementationOnce(async () => {
        reindexStarted.resolve()
        return [{ success: true, chunksCreated: 1, linksCreated: 0 }]
      })

      try {
        scheduler.schedule(testSquadId, 50)

        expect(scheduler.isPending(testSquadId)).toBe(true)
        expect(mockIndexAll).not.toHaveBeenCalled()

        // The captured timer represents the exact 50 ms boundary. Until it is
        // fired, advancing to any instant before that deadline cannot run the task.
        expect(scheduledCallback).toBeDefined()
        expect(mockIndexAll).not.toHaveBeenCalled()
        scheduledCallback!()
        await reindexStarted.promise

        expect(scheduler.isPending(testSquadId)).toBe(false)
        expect(mockIndexAll).toHaveBeenCalledTimes(1)
      } finally {
        setTimeoutSpy.mockRestore()
      }
    })

    it('debounces multiple rapid calls', async () => {
      const reindexStarted = Promise.withResolvers<void>()
      mockIndexAll.mockImplementationOnce(async () => {
        reindexStarted.resolve()
        return [{ success: true, chunksCreated: 1, linksCreated: 0 }]
      })

      // Separate the calls across event-loop turns so this still exercises
      // "later writes land while an interval is already open", without
      // depending on how much wall-clock time a turn takes.
      scheduler.schedule(testSquadId, 100)
      await new Promise<void>((resolve) => setImmediate(resolve))
      scheduler.schedule(testSquadId, 100)
      await new Promise<void>((resolve) => setImmediate(resolve))
      scheduler.schedule(testSquadId, 100)

      expect(scheduler.getStats().pending).toBe(1)
      expect(mockIndexAll).not.toHaveBeenCalled()

      await reindexStarted.promise

      expect(mockIndexAll).toHaveBeenCalledTimes(1)
    })

    it('schedules a follow-up reindex if reindex is already running', () => {
      // Mark as running
      scheduler.markAsRunning(testSquadId)

      // Try to schedule
      scheduler.schedule(testSquadId, 50)

      // Should be pending so continued updates are indexed on the next interval
      expect(scheduler.isPending(testSquadId)).toBe(true)
      expect(scheduler.isRunning(testSquadId)).toBe(true)
    })
  })

  describe('cancel', () => {
    it('cancels a pending reindex', () => {
      scheduler.schedule(testSquadId, 1000)
      expect(scheduler.isPending(testSquadId)).toBe(true)

      const cancelled = scheduler.cancel(testSquadId)

      expect(cancelled).toBe(true)
      expect(scheduler.isPending(testSquadId)).toBe(false)
    })

    it('returns false if no reindex is pending', () => {
      const cancelled = scheduler.cancel(testSquadId)
      expect(cancelled).toBe(false)
    })
  })

  describe('getStats', () => {
    it('returns correct counts', () => {
      const squad2 = 'squad-2'

      scheduler.schedule(testSquadId, 1000)
      scheduler.schedule(squad2, 1000)
      scheduler.markAsRunning('squad-3')

      const stats = scheduler.getStats()

      expect(stats.pending).toBe(2)
      expect(stats.running).toBe(1)

      // Cleanup
      scheduler.cancel(testSquadId)
      scheduler.cancel(squad2)
      scheduler.clearAllRunning()
    })
  })

  describe('concurrent reindex prevention', () => {
    it('does not start a second reindex while one is running', async () => {
      const firstReindexStarted = Promise.withResolvers<void>()
      const releaseFirstReindex = Promise.withResolvers<void>()
      const firstReindexFinished = Promise.withResolvers<void>()
      const secondReindexStarted = Promise.withResolvers<void>()
      const releaseSecondReindex = Promise.withResolvers<void>()
      const secondReindexFinished = Promise.withResolvers<void>()
      let secondDidStart = false

      mockIndexAll
        .mockImplementationOnce(async () => {
          firstReindexStarted.resolve()
          await releaseFirstReindex.promise
          firstReindexFinished.resolve()
          return [{ success: true, chunksCreated: 1, linksCreated: 0 }]
        })
        .mockImplementationOnce(async () => {
          secondDidStart = true
          secondReindexStarted.resolve()
          await releaseSecondReindex.promise
          secondReindexFinished.resolve()
          return [{ success: true, chunksCreated: 1, linksCreated: 0 }]
        })

      scheduler.schedule(testSquadId, 10)
      await firstReindexStarted.promise

      try {
        expect(scheduler.isRunning(testSquadId)).toBe(true)

        scheduler.schedule(testSquadId, 10)
        expect(scheduler.isPending(testSquadId)).toBe(true)
        expect(mockIndexAll).toHaveBeenCalledTimes(1)

        releaseFirstReindex.resolve()
        await secondReindexStarted.promise

        expect(mockIndexAll).toHaveBeenCalledTimes(2)
        expect(scheduler.isRunning(testSquadId)).toBe(true)

        releaseSecondReindex.resolve()
        await secondReindexFinished.promise
        await waitFor(() => !scheduler.isRunning(testSquadId), 'the scheduler to become idle')

        expect(scheduler.isRunning(testSquadId)).toBe(false)
      } finally {
        scheduler.cancel(testSquadId)
        releaseFirstReindex.resolve()
        releaseSecondReindex.resolve()
        await firstReindexFinished.promise
        if (secondDidStart) await secondReindexFinished.promise
        await waitFor(() => !scheduler.isRunning(testSquadId), 'the scheduler to become idle')
      }
    })
  })

  describe('reindex execution', () => {
    it('handles empty directory gracefully', async () => {
      const reindexFinished = Promise.withResolvers<void>()
      mockIndexAll.mockImplementationOnce(async () => {
        reindexFinished.resolve()
        return []
      })
      await rm(join(memoryPath, 'test.md'))

      scheduler.schedule(testSquadId, 10)
      await reindexFinished.promise
      await waitFor(() => !scheduler.isRunning(testSquadId), 'the scheduler to become idle')

      expect(scheduler.isRunning(testSquadId)).toBe(false)
    })

    it('handles indexing errors gracefully', async () => {
      const reindexFailed = Promise.withResolvers<void>()
      mockIndexAll.mockImplementationOnce(async () => {
        reindexFailed.resolve()
        throw new Error('Index error')
      })

      scheduler.schedule(testSquadId, 10)
      await reindexFailed.promise
      await waitFor(() => !scheduler.isRunning(testSquadId), 'the scheduler to become idle')

      expect(scheduler.isRunning(testSquadId)).toBe(false)
    })

    it('passes timeWindowDays as since to the file adapter', async () => {
      await SquadSourceConfig.upsert({
        squadId: testSquadId,
        sourceType: 'memory_file',
        policy: { version: 1, timeWindowDays: 7 },
      })

      const reindexStarted = Promise.withResolvers<void>()
      mockIndexAll.mockImplementationOnce(async () => {
        reindexStarted.resolve()
        return [{ success: true, chunksCreated: 1, linksCreated: 0 }]
      })

      scheduler.schedule(testSquadId, 10)

      await reindexStarted.promise

      expect(mockIndexAll).toHaveBeenCalledTimes(1)
      const [squadId, opts] = mockIndexAll.mock.calls[0] as unknown as [string, { since: string }]
      expect(squadId).toBe(testSquadId)
      expect(new Date(opts.since).getTime()).toBeLessThanOrEqual(Date.now())
      expect(new Date(opts.since).getTime()).toBeGreaterThan(Date.now() - 8 * 24 * 60 * 60 * 1000)
    })
  })
})
