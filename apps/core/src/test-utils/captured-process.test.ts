import { describe, expect, test } from 'bun:test'
import {
  describeProcessOutcome,
  expectCleanExit,
  expectFailedExit,
  MAX_DIAGNOSTIC_CHARS,
  runCapturedProcess,
  type ProcessOutcome,
} from './captured-process'

describe('runCapturedProcess', () => {
  test('captures both streams alongside a zero exit', async () => {
    const outcome = await runCapturedProcess(['sh', '-c', 'echo out; echo err >&2; exit 0'])
    expect(outcome.kind).toBe('exited')
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('out')
    expect(outcome.stderr).toContain('err')
  })

  test('a non-zero status keeps the output that explains it', async () => {
    // The defect this helper exists for: `Expected: 0, Received: 101` with the
    // panic message thrown away.
    const outcome = await runCapturedProcess(['sh', '-c', "echo 'thread panicked at src/main.rs' >&2; exit 101"])
    expect(outcome).toMatchObject({ kind: 'exited', code: 101 })
    expect(outcome.stderr).toContain('thread panicked')
    expect(describeProcessOutcome(outcome)).toContain('exited with status 101')
  })

  test('captures a large stream and clips it for the diagnostic', async () => {
    // Not a deadlock test: Bun buffers pipes internally, so awaiting exit
    // before reading does not hang (measured — 5 MB, ~8 ms). This pins the
    // clipping instead, so a chatty child cannot bury an assertion message.
    const outcome = await runCapturedProcess(['sh', '-c', 'yes abcdefghij | head -c 400000; exit 7'])
    expect(outcome.kind).toBe('exited')
    expect(outcome.code).toBe(7)
    // Kept for the assertion message, so it is clipped rather than complete.
    expect(outcome.stdout.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS + 20)
    expect(outcome.stdout).toContain('truncated')
  })

  test('a signal kill is reported as a signal, never as a non-zero exit', async () => {
    const outcome = await runCapturedProcess(['sh', '-c', 'kill -TERM $$; sleep 5'])
    expect(outcome.kind).toBe('signaled')
    expect(outcome.code).toBeNull()
    if (outcome.kind === 'signaled') expect(outcome.signal).toBe('SIGTERM')
    expect(describeProcessOutcome(outcome)).toContain('NOT a non-zero exit')
  })

  test('a command that does not exist is a spawn failure, not an exit status', async () => {
    const outcome = await runCapturedProcess(['/nonexistent/definitely-not-a-binary'])
    expect(outcome.kind).toBe('spawn-failed')
    expect(outcome.code).toBeNull()
    expect(describeProcessOutcome(outcome)).toContain('never started')
  })

  test('an exceeded budget is named as a budget, and keeps partial output', async () => {
    const outcome = await runCapturedProcess(['sh', '-c', 'echo before-the-hang; sleep 30'], { timeoutMs: 250 })
    expect(outcome.kind).toBe('timed-out')
    expect(outcome.stdout).toContain('before-the-hang')
    expect(describeProcessOutcome(outcome)).toContain('250 ms budget')
  })

  test('a missing stream reports no output instead of throwing from the helper', async () => {
    // Bun can hand back a subprocess whose stdout/stderr is undefined even with
    // stdout: 'pipe' — seen in CI as
    // `TypeError: undefined is not an object (evaluating 'stream.getReader')`.
    // The helper exists to explain a child's failure, so it must never replace
    // that with an exception about itself.
    const realSpawn = Bun.spawn
    const spawnWithoutStreams = ((...args: Parameters<typeof Bun.spawn>) => {
      const child = realSpawn(...args)
      Object.defineProperty(child, 'stdout', { value: undefined, configurable: true })
      Object.defineProperty(child, 'stderr', { value: undefined, configurable: true })
      return child
    }) as typeof Bun.spawn
    ;(Bun as { spawn: typeof Bun.spawn }).spawn = spawnWithoutStreams
    try {
      const outcome = await runCapturedProcess(['sh', '-c', 'exit 3'])
      // The exit classification still stands; only the output is unavailable.
      expect(outcome).toMatchObject({ kind: 'exited', code: 3 })
      expect(outcome.stdout).toBe('')
      expect(describeProcessOutcome(outcome)).toContain('exited with status 3')
    } finally {
      ;(Bun as { spawn: typeof Bun.spawn }).spawn = realSpawn
    }
  })

  test('credentials in child output never reach a diagnostic', async () => {
    // Binding requirement 9: diagnostics must not carry credentials.
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`
    const outcome = await runCapturedProcess(['sh', '-c', `echo "using ${token}" >&2; exit 4`])
    expect(outcome.stderr).not.toContain(token)
    expect(describeProcessOutcome(outcome)).not.toContain(token)
    // The surrounding context survives, or the diagnostic would be useless.
    expect(outcome.stderr).toContain('using')
  })
})

describe('exit assertions', () => {
  const signaled: ProcessOutcome = { kind: 'signaled', code: null, signal: 'SIGTERM', stdout: '', stderr: '' }
  const spawnFailed: ProcessOutcome = {
    kind: 'spawn-failed',
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    error: 'ENOENT',
  }
  const malformed: ProcessOutcome = {
    kind: 'malformed',
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    error: 'neither status nor signal',
  }
  const timedOut: ProcessOutcome = {
    kind: 'timed-out',
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    timeoutMs: 100,
  }

  test('expectCleanExit accepts only a real zero exit', () => {
    expect(() => expectCleanExit({ kind: 'exited', code: 0, signal: null, stdout: '', stderr: '' })).not.toThrow()
    for (const outcome of [signaled, spawnFailed, malformed, timedOut]) {
      expect(() => expectCleanExit(outcome)).toThrow()
    }
    expect(() => expectCleanExit({ kind: 'exited', code: 1, signal: null, stdout: '', stderr: '' })).toThrow(
      /exited with status 1/
    )
  })

  test('expectFailedExit rejects the environmental failures that `.not.toBe(0)` accepts', () => {
    // This is the tightening. `expect(exitCode).not.toBe(0)` passes on null, so
    // a SIGTERM'd child used to read as "the command correctly failed".
    expect(() => expectFailedExit({ kind: 'exited', code: 5, signal: null, stdout: '', stderr: '' })).not.toThrow()
    for (const outcome of [signaled, spawnFailed, malformed, timedOut]) {
      expect(() => expectFailedExit(outcome)).toThrow(/environmental failure/)
    }
    expect(() => expectFailedExit({ kind: 'exited', code: 0, signal: null, stdout: '', stderr: '' })).toThrow()
  })
})
