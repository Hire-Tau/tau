import { describe, expect, test } from 'bun:test'
import type { ExecutionStatus } from '@tau/shared'
import { executionStatusBadgeColors, executionStatusTextColors } from './execution-status'

const cases: Array<[ExecutionStatus, string, string]> = [
  ['queued', 'cyan', 'text-cyan-700'],
  ['waiting-maintenance', 'orange', 'text-orange-700'],
  ['waiting-sandbox', 'orange', 'text-orange-700'],
  ['running', 'blue', 'text-blue-700'],
  ['stopping', 'amber', 'text-amber-700'],
  ['stopped', 'gray', 'text-gray-700'],
  ['completed', 'green', 'text-green-700'],
  ['failed', 'red', 'text-red-700'],
]

describe('execution status presentation', () => {
  test('uses the shared semantic role treatment for every execution state', () => {
    for (const [status, badge, textClass] of cases) {
      expect(executionStatusBadgeColors[status]).toBe(badge)
      expect(executionStatusTextColors[status]).toContain(textClass)
    }
    expect(Object.keys(executionStatusBadgeColors).sort()).toEqual(cases.map(([status]) => status).sort())
  })
})
