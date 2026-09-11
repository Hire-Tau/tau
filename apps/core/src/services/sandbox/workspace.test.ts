import { describe, it, expect, afterEach } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { ensureWorkspace, removeWorkspace, getWorkspacePath } from './workspace'

// Use a unique test task ID prefix to avoid collisions
const TEST_PREFIX = `__test-ws-${Date.now()}`

describe('workspace service', () => {
  const createdTaskIds: string[] = []

  afterEach(async () => {
    // Clean up any workspaces created during tests
    for (const id of createdTaskIds) {
      const path = getWorkspacePath(id)
      if (existsSync(path)) {
        await rm(path, { recursive: true, force: true })
      }
    }
    createdTaskIds.length = 0
  })

  describe('getWorkspacePath', () => {
    it('returns a path ending with the task ID', () => {
      const path = getWorkspacePath('task-123')
      expect(path.endsWith('/task-123')).toBe(true)
    })

    it('does not create the directory', () => {
      const id = `${TEST_PREFIX}-no-create`
      const path = getWorkspacePath(id)
      expect(existsSync(path)).toBe(false)
    })
  })

  describe('ensureWorkspace', () => {
    it('creates the workspace directory and returns its path', () => {
      const id = `${TEST_PREFIX}-create`
      createdTaskIds.push(id)

      const path = ensureWorkspace(id)
      expect(path).toBe(getWorkspacePath(id))
      expect(existsSync(path)).toBe(true)
    })

    it('is idempotent — calling twice does not error', () => {
      const id = `${TEST_PREFIX}-idempotent`
      createdTaskIds.push(id)

      ensureWorkspace(id)
      const path = ensureWorkspace(id)
      expect(existsSync(path)).toBe(true)
    })
  })

  describe('removeWorkspace', () => {
    it('removes an existing workspace directory', () => {
      const id = `${TEST_PREFIX}-remove`
      createdTaskIds.push(id)

      const path = ensureWorkspace(id)
      expect(existsSync(path)).toBe(true)

      removeWorkspace(id)
      expect(existsSync(path)).toBe(false)
    })

    it('removes workspace with nested files inside', () => {
      const id = `${TEST_PREFIX}-nested`
      createdTaskIds.push(id)

      const path = ensureWorkspace(id)
      writeFileSync(join(path, 'test.txt'), 'hello')
      mkdirSync(join(path, 'subdir'))
      writeFileSync(join(path, 'subdir', 'nested.txt'), 'world')

      removeWorkspace(id)
      expect(existsSync(path)).toBe(false)
    })

    it('does not error when workspace does not exist', () => {
      expect(() => removeWorkspace(`${TEST_PREFIX}-nonexistent`)).not.toThrow()
    })

    it('does not remove other workspaces', () => {
      const idA = `${TEST_PREFIX}-a`
      const idB = `${TEST_PREFIX}-b`
      createdTaskIds.push(idA, idB)

      const pathA = ensureWorkspace(idA)
      const pathB = ensureWorkspace(idB)

      removeWorkspace(idA)
      expect(existsSync(pathA)).toBe(false)
      expect(existsSync(pathB)).toBe(true)
    })
  })
})
