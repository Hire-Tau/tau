import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { coreTestPlan } from '../scripts/run-core-tests'

test('Core lanes are disjoint and execute the complete discovered inventory exactly once', () => {
  const { shared, isolated, files } = coreTestPlan()
  expect([...shared, ...isolated].sort()).toEqual(files)
  expect(new Set([...shared, ...isolated]).size).toBe(files.length)
  expect(shared.length).toBeGreaterThan(0)
  expect(isolated.length).toBeGreaterThan(0)
  for (const file of shared)
    expect(readFileSync(resolve(import.meta.dir, '../apps/core', file), 'utf8')).not.toMatch(
      /\bmock\s*\.\s*module\s*\(/
    )
  expect(isolated).toContain('./src/services/memory/indexer/EmbeddingService.test.ts')
  expect(isolated).toContain('./src/services/machines/cli-bundle.test.ts')
})
