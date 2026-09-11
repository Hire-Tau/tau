import { describe, expect, test } from 'bun:test'
import { evidenceSummaryFor, recommendationSummaryFor, titleFor } from './presentation'

describe('recommendation presentation', () => {
  test.each([
    [{ type: 'add_sandbox_package' as const, package: 'jq' }, 'Add jq to the managed sandbox image'],
    [{ type: 'update_sandbox_runtime' as const, runtime: 'node' }, 'Update the node sandbox runtime'],
    [{ type: 'review_sandbox_permission' as const, tool: 'bash' }, 'Review sandbox permissions used by bash'],
    [{ type: 'improve_agent_tooling' as const, tool: 'git' }, 'Improve reliability of git'],
    [{ type: 'update_agent_guidance' as const, topic: 'handoffs' }, 'Update agent guidance for handoffs'],
  ])('titles %o', (remediation, title) => expect(titleFor(remediation)).toBe(title))

  test('generates a signal-specific recommendation summary', () => {
    expect(String(recommendationSummaryFor({ type: 'improve_agent_tooling', tool: 'git' }))).toBe(
      'git failed repeatedly in completed executions.'
    )
  })

  test('deduplicates evidence summaries', () => {
    const signal = {
      summary: 'same summary',
      remediation: { type: 'improve_agent_tooling' as const, tool: 'git' },
    }
    expect(String(evidenceSummaryFor([signal as never, signal as never]))).toBe('same summary')
  })
})
