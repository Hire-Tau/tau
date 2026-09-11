import { describe, expect, test } from 'bun:test'
import { isMigrationCancellation } from './migration-cancellation'

describe('isMigrationCancellation', () => {
  test('recognizes direct and causal typed abort signals', () => {
    const abort = new DOMException('The operation was aborted', 'AbortError')
    expect(isMigrationCancellation(abort)).toBe(true)
    expect(isMigrationCancellation({ code: 'ABORT_ERR' })).toBe(true)
    expect(isMigrationCancellation(new Error('wrapper', { cause: abort }))).toBe(true)
  })

  test('does not classify timeout or arbitrary cancel text as cancellation', () => {
    expect(isMigrationCancellation(new Error('cannot cancel completed work'))).toBe(false)
    expect(isMigrationCancellation(new DOMException('deadline', 'TimeoutError'))).toBe(false)
  })

  test('bounds cause traversal and handles cycles', () => {
    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(isMigrationCancellation(cyclic)).toBe(false)

    let cause: unknown = new DOMException('aborted', 'AbortError')
    for (let index = 0; index < 8; index++) cause = { cause }
    expect(isMigrationCancellation(cause)).toBe(false)
  })
})
