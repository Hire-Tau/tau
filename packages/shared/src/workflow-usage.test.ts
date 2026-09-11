import { expect, test } from 'bun:test'
import { createBlankWorkflow } from './workflow-editing'
import { createWorkflowRun } from './workflow-runtime'
import { formatWorkflowUsage, summarizeWorkflowUsage } from './workflow-usage'
import type { SessionUsage } from './types'
const usage = (tokens: number, cost: number, delta = true): SessionUsage => ({
  context: null,
  stats: {
    userMessages: 1,
    assistantMessages: 1,
    totalMessages: 2,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost,
  },
  ...(delta
    ? { delta: { tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens }, cost } }
    : {}),
})
test('late-settled turns stay on their original attempts and repeated steps aggregate once', () => {
  const run = createWorkflowRun(createBlankWorkflow())
  run.attempts.push({ ...run.attempts[0]!, id: 2 })
  const result = summarizeWorkflowUsage(run, [
    { agentId: 'a', attemptId: 1, usage: usage(10, 0.1) },
    { agentId: 'a', attemptId: 2, usage: usage(20, 0.2) },
    { agentId: 'a', attemptId: 1, usage: usage(5, 0.05) },
  ])
  expect(result.attempts['1']!.tokens).toBe(15)
  expect(result.attempts['2']!.tokens).toBe(20)
  expect(result.steps.execute!.tokens).toBe(35)
  expect(result.total.executions).toBe(3)
})
test('legacy cumulative totals are not doubled or guessed into steps; deltas add to their per-agent baseline', () => {
  const run = createWorkflowRun(createBlankWorkflow())
  const result = summarizeWorkflowUsage(run, [
    { agentId: 'a', attemptId: 1, usage: usage(10, 0.1, false) },
    { agentId: 'a', attemptId: 1, usage: usage(20, 0.2, false) },
    { agentId: 'a', attemptId: 1, usage: usage(3, 0.03) },
    { agentId: 'b', attemptId: null, usage: usage(7, 0.07, false) },
  ])
  expect(result.total.tokens).toBe(30)
  expect(result.unattributed.tokens).toBe(27)
  expect(result.steps.execute!.tokens).toBe(3)
  expect(result.total.cost).toBeCloseTo(0.3)
})
test('unmeasured executions remain visibly pending rather than claiming zero-cost work', () => {
  const result = summarizeWorkflowUsage(createWorkflowRun(createBlankWorkflow()), [
    { agentId: 'a', attemptId: 1, usage: null },
  ])
  expect(result.steps.execute!.measuredExecutions).toBe(0)
  expect(formatWorkflowUsage(result.steps.execute!)).toContain('pending')
  expect(formatWorkflowUsage(summarizeWorkflowUsage(createWorkflowRun(createBlankWorkflow()), []).total)).toBe(
    'No executions yet'
  )
})
