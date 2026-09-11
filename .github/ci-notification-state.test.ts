import { expect, test } from 'bun:test'
import {
  advanceWorkflowState,
  ciNotificationSchema,
  type Notification,
} from '../apps/core/src/services/work-streams/ci-notification-state'

const input: Notification = {
  recipientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  repository: 'acme/repo',
  workflowId: '1',
  runId: '100',
  runNumber: '1',
  runAttempt: '1',
  conclusion: 'failure',
  subject: 'Synthetic CI',
  content: 'Synthetic result',
}

test('A then B then replay A preserves independent workflow high waters, including rename', () => {
  const a = advanceWorkflowState({}, input)
  if (!a.accepted) throw new Error(a.reason)
  const b = advanceWorkflowState(a, { ...input, workflowId: '2', runId: '200' })
  if (!b.accepted) throw new Error(b.reason)
  expect(advanceWorkflowState(b, { ...input, subject: 'Renamed CI' }).accepted).toBe(false)
  const next = advanceWorkflowState(b, { ...input, runId: '101', runNumber: '2' })
  expect(next.accepted).toBe(true)
  if (next.accepted) expect(Object.keys(next.workflows)).toHaveLength(2)
})

test('attempts compare numerically, stale delivery cannot regress state, and inconsistent identity fails closed', () => {
  const state = advanceWorkflowState({}, { ...input, runAttempt: '9' })
  if (!state.accepted) throw new Error(state.reason)
  const next = advanceWorkflowState(state, { ...input, runAttempt: '10' })
  expect(next.accepted).toBe(true)
  expect(advanceWorkflowState(next, { ...input, runAttempt: '9' }).accepted).toBe(false)
  expect(advanceWorkflowState(next, { ...input, runAttempt: '11', runId: '500' }).accepted).toBe(false)
})

test('legacy and malformed state block only that stream and missing payload identity is rejected', () => {
  expect(advanceWorkflowState({ lastNotifiedRunId: '100' }, input).accepted).toBe(false)
  expect(advanceWorkflowState({ workflows: { bad: {} } }, input).accepted).toBe(false)
  for (const state of [null, 'bad', [], { workflows: null }])
    expect(advanceWorkflowState(state, input).accepted).toBe(false)
  expect(advanceWorkflowState({}, input).accepted).toBe(true)
  for (const field of ['workflowId', 'runId', 'runNumber', 'runAttempt'] as const) {
    for (const value of [undefined, '', 'not-numeric', '1.5', '-1', '0']) {
      expect(ciNotificationSchema.safeParse({ ...input, [field]: value }).success).toBe(false)
    }
  }
})

test('capacity is bounded without evicting a replay watermark, even after inbox retention or workflow deletion', () => {
  let state: Record<string, unknown> = {}
  for (let i = 1; i <= 128; i++) {
    const next = advanceWorkflowState(state, { ...input, workflowId: String(i) })
    if (!next.accepted) throw new Error(next.reason)
    state = next
  }
  expect(advanceWorkflowState(state, { ...input, workflowId: '129' }).accepted).toBe(false)
  expect(advanceWorkflowState(state, input).accepted).toBe(false)
  expect(advanceWorkflowState(state, { ...input, runId: '101', runNumber: '2' }).accepted).toBe(true)
})

test('an explicit legacy migration preserves the recorded workflow high water without suppressing other workflows', () => {
  const legacy = { lastNotifiedRunId: '100', lastNotifiedRunAttempt: '9', lastNotifiedConclusion: 'failure' }
  expect(advanceWorkflowState(legacy, input).accepted).toBe(false)
  // Operator-verified mapping of run 100 to workflow 1 / run number 1. There
  // is deliberately no heuristic that can infer it from the scalar alone.
  const migrated = {
    workflows: { 'acme/repo#1': { runId: '100', runNumber: '1', runAttempt: '9', conclusion: 'failure' } },
  }
  expect(advanceWorkflowState(migrated, { ...input, runAttempt: '9' }).accepted).toBe(false)
  expect(advanceWorkflowState(migrated, { ...input, runAttempt: '10' }).accepted).toBe(true)
  expect(advanceWorkflowState(migrated, { ...input, workflowId: '2' }).accepted).toBe(true)
})
