import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { db } from '../../db'
import { squads } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { ListService } from './ListService'
import { ensureSquadMemoryPath } from './paths'

const listService = ListService.instance()

describe('memory ListService', () => {
  const testSquadId = crypto.randomUUID()
  let memoryPath: string

  beforeAll(async () => {
    await db.insert(squads).values({
      id: testSquadId,
      name: 'List Service Test Squad',
      purpose: 'Testing memory list service',
      status: 'active',
    })
    memoryPath = ensureSquadMemoryPath(testSquadId)
  })

  afterAll(async () => {
    await db.delete(squads).where(eq(squads.id, testSquadId))
    await rm(memoryPath, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await rm(memoryPath, { recursive: true, force: true })
    await mkdir(join(memoryPath, 'references'), { recursive: true })
    await mkdir(join(memoryPath, 'decisions'), { recursive: true })
    await mkdir(join(memoryPath, 'patterns'), { recursive: true })
    await writeFile(join(memoryPath, 'references', 'api.md'), '# API')
  })

  it('accepts root and common directory paths', async () => {
    for (const path of [
      '/memory',
      '/memory/',
      '/memory/references',
      '/memory/references/',
      '/memory/decisions',
      '/memory/patterns',
    ]) {
      const result = await listService.list(testSquadId, path)
      expect(result.success).toBe(true)
      expect(result.path).toBe(path)
    }
  })

  it('lists directory contents with memory paths', async () => {
    const result = await listService.list(testSquadId, '/memory/references')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.entries).toEqual([{ name: 'api.md', path: '/memory/references/api.md', type: 'file' }])
    }
  })

  it('rejects invalid directory paths', async () => {
    for (const path of ['', 'relative/path', '/other/path', '/memory/../secrets', '/memory/references\x00']) {
      const result = await listService.list(testSquadId, path)
      expect(result.success).toBe(false)
    }
  })
})
