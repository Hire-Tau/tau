import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (name: string) => readFileSync(join(import.meta.dir, name), 'utf8')

describe('agent graph legends', () => {
  test('derive waiting-input markers from the same shared role as graph nodes', () => {
    for (const name of ['AgentVisualization.tsx', 'SquadUniverse.tsx']) {
      const source = read(name)
      expect(source).toContain("webStatus(AGENT_STATUS_ROLE['waiting-input']).markerClass")
      expect(source).not.toMatch(/bg-red-500[^\n]*(Waiting Input|Waiting)/)
    }
  })
})
