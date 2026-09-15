import { expect, test } from 'bun:test'
import { shouldPushAssistantUpdate } from './notification'

test('pushes an actionable current update', () => {
  for (const reportedStatus of ['needs-input', 'completed', 'failed'] as const) {
    expect(shouldPushAssistantUpdate({ isCurrentRequest: true, changedStatus: true, reportedStatus })).toBe(true)
  }
})

test('does not push routine or stale updates', () => {
  expect(shouldPushAssistantUpdate({ isCurrentRequest: true, changedStatus: true, reportedStatus: 'waiting' })).toBe(
    false
  )
  expect(shouldPushAssistantUpdate({ isCurrentRequest: true, changedStatus: true, reportedStatus: 'working' })).toBe(
    false
  )
  expect(shouldPushAssistantUpdate({ isCurrentRequest: true, changedStatus: true, reportedStatus: 'cancelled' })).toBe(
    false
  )
  expect(shouldPushAssistantUpdate({ isCurrentRequest: true, changedStatus: false, reportedStatus: null })).toBe(false)
  expect(shouldPushAssistantUpdate({ isCurrentRequest: false, changedStatus: true, reportedStatus: 'completed' })).toBe(
    false
  )
  expect(shouldPushAssistantUpdate({ isCurrentRequest: true, changedStatus: false, reportedStatus: 'completed' })).toBe(
    false
  )
})
