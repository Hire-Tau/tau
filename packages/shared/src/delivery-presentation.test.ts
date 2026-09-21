import { expect, test } from 'bun:test'
import {
  selectWorkStreamPresentationState,
  workStreamNeedsHumanAttention,
  WORK_STREAM_STATUS_ROLE,
} from './status-presentation'
import { workBucket } from './live-activity'

const cases = [
  ['approval', 'delivery_approval', 'review', true, 'needsYou'],
  ['review', 'delivery_review', 'review', true, 'needsYou'],
  ['merge', 'delivery_merge', 'review', true, 'needsYou'],
  ['external', 'delivery_external', 'externalWait', false, 'blocked'],
  ['setup', 'delivery_setup', 'danger', false, 'blocked'],
] as const
for (const [kind, state, role, attention, bucket] of cases) {
  test(`authoritative delivery ${kind} survives explicit empty waits`, () => {
    const facts = { status: 'active' as const, derivedState: 'idle' as const, openWaits: [], delivery: { kind } }
    expect(selectWorkStreamPresentationState(facts)).toBe(state)
    expect(WORK_STREAM_STATUS_ROLE[selectWorkStreamPresentationState(facts)]).toBe(role)
    expect(workStreamNeedsHumanAttention(facts)).toBe(attention)
    expect(workBucket(facts)).toBe(bucket)
    expect(selectWorkStreamPresentationState({ ...facts, pause: {} })).toBe('paused')
    expect(selectWorkStreamPresentationState({ ...facts, status: 'done' })).toBe('done')
    expect(selectWorkStreamPresentationState({ ...facts, openWaits: [{ type: 'question' }] })).toBe('waiting_on_answer')
  })
}
test('native preserves failure, neutral pause and legacy manual attention', () => {
  expect(workBucket({ status: 'active', derivedState: 'execution_failed', openWaits: [] })).toBe('blocked')
  expect(workBucket({ status: 'active', pause: {}, openWaits: [{ type: 'manual' }] })).toBe('paused')
  expect(workBucket({ status: 'active', derivedState: 'blocked' })).toBe('needsYou')
})

test('only the identified delivery approval wait is reinterpreted; other manual blockers win', () => {
  const facts = { status: 'active' as const, delivery: { kind: 'approval' as const, approvalWaitId: 'approval' } }
  expect(selectWorkStreamPresentationState({ ...facts, openWaits: [{ id: 'approval', type: 'manual' }] })).toBe(
    'delivery_approval'
  )
  expect(
    selectWorkStreamPresentationState({
      ...facts,
      openWaits: [
        { id: 'approval', type: 'manual' },
        { id: 'other', type: 'manual' },
      ],
    })
  ).toBe('blocked')
  expect(selectWorkStreamPresentationState({ ...facts, openWaits: [], derivedState: 'execution_failed' })).toBe(
    'execution_failed'
  )
})
