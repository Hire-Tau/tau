import { expect, test } from 'bun:test'
import { primaryFirstError } from './primary-first-error'

test('keeps the original failure first and sanitizes secondary failures', () => {
  const primary = new Error('expected started, received no-capacity')
  const secondary = new Error('postgres://user:secret@live.example/tau')

  const result = primaryFirstError(primary, 'Provider invariant failed', [
    { phase: 'provider-invariant-diagnostics', error: secondary },
  ])

  expect(result.errors[0]).toBe(primary)
  expect(result.cause).toBe(primary)
  expect((result.errors[1] as Error).message).toBe('Secondary failure: provider-invariant-diagnostics')
  const renderedSecondaries = result.errors
    .slice(1)
    .map((error) => (error instanceof Error ? error.message : String(error)))
  expect(renderedSecondaries.join('\n')).not.toContain('secret')
  expect(result.message).toBe('Provider invariant failed')
})

test('preserves an arbitrary primary value by identity', () => {
  const primary = { failure: 'original' }

  const result = primaryFirstError(primary, 'Invariant failed', [])

  expect(result.errors[0]).toBe(primary)
  expect(result.cause).toBe(primary)
})

test('replaces an invalid phase label without rendering it', () => {
  const maliciousPhase = 'diagnostics\npostgres://user:secret@live.example/tau'

  const result = primaryFirstError(new Error('primary'), 'Invariant failed', [
    { phase: maliciousPhase, error: new Error('secondary secret') },
  ])

  expect((result.errors[1] as Error).message).toBe('Secondary failure: secondary-operation')
  expect(String(result.errors[1])).not.toContain('secret')
})
