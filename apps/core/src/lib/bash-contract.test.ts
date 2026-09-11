import { describe, expect, test } from 'bun:test'
import {
  BASH_DEFAULT_TIMEOUT_SECONDS,
  BASH_MAX_TIMEOUT_SECONDS,
  FOREGROUND_BASH_GUIDANCE,
  normalizeBashTimeoutSeconds,
} from './bash-contract'

describe('foreground Bash timeout contract', () => {
  test('defaults invalid values and caps explicit timeouts at one hour', () => {
    expect(BASH_DEFAULT_TIMEOUT_SECONDS).toBe(180)
    expect(BASH_MAX_TIMEOUT_SECONDS).toBe(3_600)
    for (const value of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeBashTimeoutSeconds(value)).toBe(180)
    }
    expect(normalizeBashTimeoutSeconds(42)).toBe(42)
    expect(normalizeBashTimeoutSeconds(7_200)).toBe(3_600)
  })

  test('explicitly rejects detached completion-critical work', () => {
    expect(FOREGROUND_BASH_GUIDANCE).toContain('foreground')
    expect(FOREGROUND_BASH_GUIDANCE).toContain('3600')
    expect(FOREGROUND_BASH_GUIDANCE.toLowerCase()).toContain('detached background processes are unsupported')
    expect(FOREGROUND_BASH_GUIDANCE).not.toContain('For long-running tasks, use tmux')
  })
})
