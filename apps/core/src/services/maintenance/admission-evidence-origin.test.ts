import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const baseSource = readFileSync(join(import.meta.dir, '../../entities/agent-runners/base.ts'), 'utf8')
const exactCount = (source: string, value: string) => source.split(value).length - 1

test('runner pause sites bind their exact structured evidence origins', () => {
  expect(exactCount(baseSource, "admissionLeasePauseEvidence(lease, 'write-phase-begin')")).toBe(1)
  expect(exactCount(baseSource, "'write-phase-finish-settlement' | 'write-phase-finish-running'")).toBe(1)
  expect(exactCount(baseSource, "await finishOrThrow('write-phase-finish-settlement')")).toBe(1)
  expect(exactCount(baseSource, "await finishOrThrow('write-phase-finish-running')")).toBe(1)
  expect(exactCount(baseSource, "admissionLeasePauseEvidence(admissionLease, 'scope-abort-effective-change')")).toBe(1)
  expect(baseSource.match(/admissionLeasePauseEvidence\(/g)?.length).toBe(3)
  expect(baseSource).not.toMatch(/new MaintenanceAdmissionPaused\([^)]*\.generation\)/)
})
