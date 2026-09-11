/**
 * LockManager Tests
 */

import { describe, it, expect } from 'bun:test'
import { LockManager } from './LockManager'

describe('LockManager', () => {
  describe('withLock', () => {
    it('executes operation and returns result', async () => {
      const manager = new LockManager()

      const result = await manager.withLock('key-1', async () => {
        return 'test-result'
      })

      expect(result).toBe('test-result')
    })

    it('serializes concurrent operations for same key', async () => {
      const manager = new LockManager()
      const order: number[] = []

      const op1 = manager.withLock('key-1', async () => {
        order.push(1)
        await new Promise((r) => setTimeout(r, 50))
        order.push(2)
        return 'op1'
      })

      const op2 = manager.withLock('key-1', async () => {
        order.push(3)
        await new Promise((r) => setTimeout(r, 10))
        order.push(4)
        return 'op2'
      })

      const results = await Promise.all([op1, op2])

      expect(results).toEqual(['op1', 'op2'])
      // Operations should be serialized: 1, 2 complete before 3, 4 start
      expect(order).toEqual([1, 2, 3, 4])
    })

    it('allows concurrent operations for different keys', async () => {
      const manager = new LockManager()
      const order: string[] = []

      const op1 = manager.withLock('key-1', async () => {
        order.push('1-start')
        await new Promise((r) => setTimeout(r, 50))
        order.push('1-end')
        return 'op1'
      })

      const op2 = manager.withLock('key-2', async () => {
        order.push('2-start')
        await new Promise((r) => setTimeout(r, 10))
        order.push('2-end')
        return 'op2'
      })

      const results = await Promise.all([op1, op2])

      expect(results).toEqual(['op1', 'op2'])
      // Operations run concurrently: both start before either ends
      expect(order.slice(0, 2)).toContain('1-start')
      expect(order.slice(0, 2)).toContain('2-start')
    })

    it('releases lock on error', async () => {
      const manager = new LockManager()

      try {
        await manager.withLock('key-1', async () => {
          throw new Error('Test error')
        })
      } catch {
        // Expected
      }

      // Lock should be released - another operation should run immediately
      const result = await manager.withLock('key-1', async () => 'success')
      expect(result).toBe('success')
    })
  })

  describe('isLocked', () => {
    it('returns false when no operation running', () => {
      const manager = new LockManager()
      expect(manager.isLocked('key-1')).toBe(false)
    })

    it('returns true when operation running', async () => {
      const manager = new LockManager()

      let isLockedDuring = false
      await manager.withLock('key-1', async () => {
        isLockedDuring = manager.isLocked('key-1')
      })

      expect(isLockedDuring).toBe(true)
      expect(manager.isLocked('key-1')).toBe(false)
    })
  })

  describe('activeLockCount', () => {
    it('returns 0 when no operations running', () => {
      const manager = new LockManager()
      expect(manager.activeLockCount).toBe(0)
    })

    it('returns count of active locks', async () => {
      const manager = new LockManager()

      let countDuring = 0
      const op1 = manager.withLock('key-1', async () => {
        await new Promise((r) => setTimeout(r, 50))
      })

      // Start second operation for different key
      const op2 = manager.withLock('key-2', async () => {
        countDuring = manager.activeLockCount
        await new Promise((r) => setTimeout(r, 10))
      })

      await Promise.all([op1, op2])

      expect(countDuring).toBe(2)
      expect(manager.activeLockCount).toBe(0)
    })
  })
})
