/**
 * DebouncedQueue Tests
 */

import { describe, it, expect, afterEach, mock } from 'bun:test'
import { DebouncedQueue } from './DebouncedQueue'

describe('DebouncedQueue', () => {
  let queue: DebouncedQueue

  afterEach(() => {
    queue?.clearAllPending()
    queue?.clearAllRunning()
  })

  describe('constructor', () => {
    it('creates queue with default settings', () => {
      queue = new DebouncedQueue()
      expect(queue.getStats()).toEqual({ pending: 0, running: 0 })
    })

    it('accepts custom defaultDelayMs', () => {
      queue = new DebouncedQueue({ defaultDelayMs: 5000 })
      expect(queue.getStats()).toEqual({ pending: 0, running: 0 })
    })
  })

  describe('schedule', () => {
    it('schedules an operation', () => {
      queue = new DebouncedQueue({ defaultDelayMs: 1000 })
      const operation = mock(() => Promise.resolve())

      queue.schedule('key-1', operation)

      expect(queue.isPending('key-1')).toBe(true)
      expect(queue.isRunning('key-1')).toBe(false)
      expect(operation).not.toHaveBeenCalled()
    })

    it('executes operation after delay', async () => {
      queue = new DebouncedQueue({ defaultDelayMs: 50 })
      const operation = mock(() => Promise.resolve())

      queue.schedule('key-1', operation)

      await new Promise((r) => setTimeout(r, 100))

      expect(operation).toHaveBeenCalledTimes(1)
      expect(queue.isPending('key-1')).toBe(false)
    })

    it('debounces rapid calls', async () => {
      queue = new DebouncedQueue({ defaultDelayMs: 100 })
      const operation = mock(() => Promise.resolve())

      queue.schedule('key-1', operation)
      await new Promise((r) => setTimeout(r, 30))
      queue.schedule('key-1', operation)
      await new Promise((r) => setTimeout(r, 30))
      queue.schedule('key-1', operation)

      expect(queue.getStats().pending).toBe(1)

      await new Promise((r) => setTimeout(r, 150))

      expect(operation).toHaveBeenCalledTimes(1)
    })

    it('skips scheduling when already running', () => {
      queue = new DebouncedQueue({ defaultDelayMs: 100 })
      const operation = mock(() => Promise.resolve())

      queue.markAsRunning('key-1')
      queue.schedule('key-1', operation)

      expect(queue.isPending('key-1')).toBe(false)
      expect(queue.isRunning('key-1')).toBe(true)
    })

    it('uses custom delay when provided', async () => {
      queue = new DebouncedQueue({ defaultDelayMs: 1000 })
      const operation = mock(() => Promise.resolve())

      queue.schedule('key-1', operation, 50)

      await new Promise((r) => setTimeout(r, 100))

      expect(operation).toHaveBeenCalledTimes(1)
    })
  })

  describe('cancel', () => {
    it('cancels a pending operation', () => {
      queue = new DebouncedQueue({ defaultDelayMs: 1000 })
      const operation = mock(() => Promise.resolve())

      queue.schedule('key-1', operation)
      expect(queue.cancel('key-1')).toBe(true)
      expect(queue.isPending('key-1')).toBe(false)
    })

    it('returns false for non-existent key', () => {
      queue = new DebouncedQueue()
      expect(queue.cancel('non-existent')).toBe(false)
    })
  })

  describe('callbacks', () => {
    it('calls onStart when operation starts', async () => {
      const onStart = mock(() => {})
      queue = new DebouncedQueue({ defaultDelayMs: 10, onStart })
      const operation = mock(() => Promise.resolve())

      queue.schedule('key-1', operation)
      await new Promise((r) => setTimeout(r, 50))

      expect(onStart).toHaveBeenCalledWith('key-1')
    })

    it('calls onComplete when operation succeeds', async () => {
      const onComplete = mock(() => {})
      queue = new DebouncedQueue({ defaultDelayMs: 10, onComplete })
      const operation = mock(() => Promise.resolve())

      queue.schedule('key-1', operation)
      await new Promise((r) => setTimeout(r, 50))

      expect(onComplete).toHaveBeenCalledWith('key-1')
    })

    it('calls onComplete with error when operation fails', async () => {
      const onComplete = mock(() => {})
      queue = new DebouncedQueue({ defaultDelayMs: 10, onComplete })
      const error = new Error('Test error')
      const operation = mock(() => Promise.reject(error))

      queue.schedule('key-1', operation)
      await new Promise((r) => setTimeout(r, 50))

      expect(onComplete).toHaveBeenCalledWith('key-1', error)
    })
  })

  describe('clearAll methods', () => {
    it('clearAllPending removes all pending', () => {
      queue = new DebouncedQueue({ defaultDelayMs: 10000 })

      queue.schedule('key-1', () => Promise.resolve())
      queue.schedule('key-2', () => Promise.resolve())

      expect(queue.getStats().pending).toBe(2)

      queue.clearAllPending()

      expect(queue.getStats().pending).toBe(0)
    })

    it('clearAllRunning removes all running flags', () => {
      queue = new DebouncedQueue()

      queue.markAsRunning('key-1')
      queue.markAsRunning('key-2')

      expect(queue.getStats().running).toBe(2)

      queue.clearAllRunning()

      expect(queue.getStats().running).toBe(0)
    })
  })
})
