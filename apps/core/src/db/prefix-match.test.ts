import { describe, it, expect } from 'bun:test'
import { AmbiguousPrefixError } from './prefix-match'

describe('prefix-match utilities', () => {
  describe('AmbiguousPrefixError', () => {
    it('creates error with descriptive message', () => {
      const error = new AmbiguousPrefixError('task', 'abc123')
      expect(error.message).toBe('Ambiguous task ID prefix "abc123" matches multiple records')
      expect(error.name).toBe('AmbiguousPrefixError')
    })

    it('works with different entity types', () => {
      const scheduleError = new AmbiguousPrefixError('schedule', 'def456')
      expect(scheduleError.message).toBe('Ambiguous schedule ID prefix "def456" matches multiple records')

      const runError = new AmbiguousPrefixError('agent', 'ghi789')
      expect(runError.message).toBe('Ambiguous agent ID prefix "ghi789" matches multiple records')
    })

    it('is an instance of Error', () => {
      const error = new AmbiguousPrefixError('task', 'abc')
      expect(error instanceof Error).toBe(true)
    })
  })
})
