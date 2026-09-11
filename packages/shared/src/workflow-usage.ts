import type { SessionUsage } from './types'
import type { WorkflowRun } from './workflow-runtime'

export interface WorkflowUsageAmount {
  tokens: number
  cost: number
  executions: number
  measuredExecutions: number
}
export interface WorkflowUsage {
  total: WorkflowUsageAmount
  unattributed: WorkflowUsageAmount
  attempts: Record<string, WorkflowUsageAmount>
  steps: Record<string, WorkflowUsageAmount>
}
const empty = (): WorkflowUsageAmount => ({ tokens: 0, cost: 0, executions: 0, measuredExecutions: 0 })
const finite = (value: number) => (Number.isFinite(value) && value >= 0 ? value : 0)
const add = (target: WorkflowUsageAmount, amount: WorkflowUsageAmount) => {
  target.tokens += amount.tokens
  target.cost += amount.cost
  target.executions += amount.executions
  target.measuredExecutions += amount.measuredExecutions
}

/** Deltas are exact per-turn measurements. Legacy cumulative snapshots cannot be assigned to a step. */
export function summarizeWorkflowUsage(
  run: WorkflowRun,
  rows: Array<{ agentId: string; attemptId: number | null; usage: SessionUsage | null }>
): WorkflowUsage {
  const result: WorkflowUsage = { total: empty(), unattributed: empty(), attempts: {}, steps: {} }
  for (const attempt of run.attempts) {
    result.attempts[attempt.id] = empty()
    result.steps[attempt.stepId] ??= empty()
  }
  const legacy = new Map<string, { tokens: number; cost: number }>()
  for (const row of rows) {
    const delta = row.usage?.delta
    const attempt = run.attempts.find((entry) => entry.id === row.attemptId)
    const amount = {
      tokens: finite(delta?.tokens.total ?? 0),
      cost: finite(delta?.cost ?? 0),
      executions: 1,
      measuredExecutions: row.usage ? 1 : 0,
    }
    if (delta && attempt) {
      add(result.attempts[attempt.id]!, amount)
      add(result.steps[attempt.stepId]!, amount)
    } else {
      // Pending turns retain their attempt, but are not presented as measured zero usage.
      if (!row.usage && attempt) {
        add(result.attempts[attempt.id]!, amount)
        add(result.steps[attempt.stepId]!, amount)
      } else add(result.unattributed, amount)
      if (row.usage && !delta) {
        const previous = legacy.get(row.agentId) ?? { tokens: 0, cost: 0 }
        legacy.set(row.agentId, {
          tokens: Math.max(previous.tokens, finite(row.usage.stats.tokens.total)),
          cost: Math.max(previous.cost, finite(row.usage.stats.cost)),
        })
      }
    }
    add(result.total, amount)
  }
  for (const amount of legacy.values()) {
    result.unattributed.tokens += amount.tokens
    result.unattributed.cost += amount.cost
    result.total.tokens += amount.tokens
    result.total.cost += amount.cost
  }
  return result
}

export function formatWorkflowUsage(amount: WorkflowUsageAmount): string {
  if (!amount.executions) return 'No executions yet'
  if (!amount.measuredExecutions) return 'Usage pending or unavailable'
  const cost = amount.cost < 0.01 ? amount.cost.toFixed(4) : amount.cost.toFixed(2)
  return `${amount.tokens.toLocaleString('en-US')} tokens · $${cost}${amount.measuredExecutions < amount.executions ? ' · partial' : ''}`
}
