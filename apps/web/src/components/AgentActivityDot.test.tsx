import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentStatus } from '@tau/shared'
import { AgentActivityDot } from './AgentActivityDot'

const cases: Array<[AgentStatus, string, string]> = [
  ['active', 'Working', 'bg-blue-500'],
  ['idle', 'Idle', 'bg-gray-500'],
  ['waiting-input', 'Waiting for input', 'bg-purple-500'],
  ['compacting', 'Compacting', 'bg-amber-500'],
  ['resetting', 'Resetting', 'bg-amber-500'],
  ['dormant', 'Dormant', 'bg-gray-500'],
  ['terminated', 'Terminated', 'bg-gray-500'],
]

describe('AgentActivityDot', () => {
  for (const [status, label, colorClass] of cases) {
    test(`renders ${status} accessibly`, () => {
      const html = renderToStaticMarkup(<AgentActivityDot status={status} />)

      expect(html).toContain(`aria-label="Agent activity: ${label}"`)
      expect(html).toContain(`title="Agent activity: ${label}"`)
      expect(html).toContain(colorClass)
    })
  }
})
