import { afterEach, describe, expect, jest, test } from 'bun:test'
import { lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { terminateProcess } from './subprocess-lifecycle'
import {
  amtpConformancePhases,
  cleanupFileCapturedChild,
  lastAmtpUploadPhase,
  spawnFileCapturedChild,
  readFileCapturedChildTails,
  runBoundedCleanupPhases,
  runFileCapturedProcess,
  stripAmtpConformancePhases,
  waitForCapturedJsonLine,
  type FileCapturedChild,
} from './node-conformance-process'

let dirs: string[] = []

afterEach(async () => {
  jest.useRealTimers()
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs = []
})

async function captureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'amtp-capture-test-'))
  dirs.push(dir)
  return dir
}

describe('correlated AMTP conformance phases', () => {
  test('accepts only correlated entrypoint and whoami lifecycle phases', () => {
    const operationId = '11111111-1111-4111-8111-111111111111'
    const stderr = [
      { kind: 'amtp-conformance-phase', operationId, operation: 'entrypoint', phase: 'module-loaded' },
      { kind: 'amtp-conformance-phase', operationId, operation: 'whoami', phase: 'process:start' },
      { kind: 'amtp-conformance-phase', operationId, operation: 'whoami', phase: 'registrations-read:done' },
      { kind: 'amtp-conformance-phase', operationId, operation: 'whoami', phase: 'sqlite-close:done' },
      { kind: 'amtp-conformance-phase', operationId: crypto.randomUUID(), operation: 'whoami', phase: 'process:start' },
      { kind: 'amtp-conformance-phase', operationId, operation: 'register', phase: 'module-loaded' },
      { kind: 'amtp-conformance-phase', operationId, operation: 'unknown', phase: 'process:start' },
      { kind: 'amtp-conformance-phase', operationId, operation: 'whoami', phase: 'unknown' },
      { kind: 'amtp-conformance-phase', operationId, operation: 'whoami', phase: 'process:start', extra: true },
      'arbitrary stderr',
    ]
      .map((record) => (typeof record === 'string' ? record : JSON.stringify(record)))
      .join('\n')

    expect(amtpConformancePhases(stderr, operationId)).toEqual([
      { operation: 'entrypoint', phase: 'module-loaded' },
      { operation: 'whoami', phase: 'process:start' },
      { operation: 'whoami', phase: 'registrations-read:done' },
      { operation: 'whoami', phase: 'sqlite-close:done' },
    ])
  })

  test('strips only validated correlated phase records from stderr', () => {
    const operationId = '11111111-1111-4111-8111-111111111111'
    const phase = JSON.stringify({
      kind: 'amtp-conformance-phase',
      operationId,
      operation: 'entrypoint',
      phase: 'module-loaded',
    })
    const wrongOperation = JSON.stringify({
      kind: 'amtp-conformance-phase',
      operationId,
      operation: 'register',
      phase: 'module-loaded',
    })
    const error = `{"error":"preserve me"}\n${wrongOperation}\nplain diagnostic\n`
    expect(stripAmtpConformancePhases(`${phase}\n${error}`, operationId)).toBe(error)
  })

  test('selects the complete register lifecycle for the requested operation', () => {
    const operationId = '11111111-1111-4111-8111-111111111111'
    expect(
      amtpConformancePhases(
        [
          JSON.stringify({
            kind: 'amtp-conformance-phase',
            operationId,
            operation: 'register',
            phase: 'process:start',
          }),
          JSON.stringify({
            kind: 'amtp-conformance-phase',
            operationId,
            operation: 'register',
            phase: 'sqlite-open:done',
          }),
          JSON.stringify({
            kind: 'amtp-conformance-phase',
            operationId,
            operation: 'register',
            phase: 'registration-write:done',
          }),
          JSON.stringify({
            kind: 'amtp-conformance-phase',
            operationId,
            operation: 'register',
            phase: 'response-write:done',
          }),
          JSON.stringify({
            kind: 'amtp-conformance-phase',
            operationId: crypto.randomUUID(),
            operation: 'register',
            phase: 'response-write:done',
          }),
        ].join('\n'),
        operationId
      )
    ).toEqual([
      { operation: 'register', phase: 'process:start' },
      { operation: 'register', phase: 'sqlite-open:done' },
      { operation: 'register', phase: 'registration-write:done' },
      { operation: 'register', phase: 'response-write:done' },
    ])
  })

  test('selects only strict records for the requested operation', () => {
    const operationId = '11111111-1111-4111-8111-111111111111'
    expect(
      amtpConformancePhases(
        [
          JSON.stringify({
            kind: 'amtp-conformance-phase',
            operationId,
            operation: 'upload',
            phase: 'source-read:done',
          }),
          JSON.stringify({
            kind: 'amtp-conformance-phase',
            operationId: '22222222-2222-4222-8222-222222222222',
            operation: 'card-set',
            phase: 'sqlite-open:done',
          }),
          JSON.stringify({ kind: 'amtp-conformance-phase', operationId, operation: 'upload', phase: 'attacker-phase' }),
        ].join('\n'),
        operationId
      )
    ).toEqual([{ operation: 'upload', phase: 'source-read:done' }])
  })
})

describe('lastAmtpUploadPhase', () => {
  test('parses bounded AMTP upload phases and ignores arbitrary stderr', () => {
    expect(
      lastAmtpUploadPhase(
        [
          'warning',
          '{"kind":"amtp-upload-phase","phase":"source-read:done"}',
          '{"kind":"amtp-upload-phase","phase":"blob-file-fsync:start"}',
          '{"kind":"amtp-upload-phase","phase":"attacker-controlled"}',
        ].join('\n')
      )
    ).toBe('blob-file-fsync:start')
  })
})

describe('real AMTP CLI lifecycle', () => {
  test('awaits asynchronous command actions before the process can exit', async () => {
    const nodeEntry = join(import.meta.dir, '../../../../../node_modules/amtp-node/src/index.ts')
    const source = await Bun.file(nodeEntry).text()

    expect(nodeEntry).toContain('/node_modules/amtp-node/src/index.ts')
    expect(source).toContain('await program.parseAsync()')
    expect(source).not.toContain('program.parse()')
  })
})

describe('real AMTP upload trace', () => {
  test('reports the complete ordered phase sequence without source contents', async () => {
    const dir = await captureDir()
    const home = await captureDir()
    const source = join(dir, 'trace-source.txt')
    const sourceContents = 'trace-source-contents-must-stay-private'
    await writeFile(source, sourceContents)
    const nodeEntry = Bun.resolveSync('amtp-node', import.meta.dir)
    const command = (args: string[]) => ['bun', 'run', nodeEntry, '--home', home, '--json', ...args]

    const init = await runFileCapturedProcess(command(['init']), {
      phase: 'amtp-cli:init',
      timeoutMs: 5_000,
      captureDir: dir,
    })
    expect(init.exitCode).toBe(0)

    const upload = await runFileCapturedProcess(command(['attach', 'upload', source]), {
      phase: 'amtp-cli:attach-upload',
      timeoutMs: 5_000,
      captureDir: dir,
      env: { AMTP_CONFORMANCE_TRACE_UPLOAD: '1' },
      terminalOutput: (stdout) => {
        try {
          return typeof (JSON.parse(stdout) as { attachmentId?: unknown }).attachmentId === 'string'
        } catch {
          return false
        }
      },
    })

    expect(upload.exitCode).toBe(0)
    expect(JSON.parse(upload.stdout)).toMatchObject({
      filename: 'trace-source.txt',
      contentType: 'application/octet-stream',
      byteSize: sourceContents.length,
    })
    expect(upload.stderr).not.toContain(sourceContents)
    expect(
      upload.stderr
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { phase: string }).phase)
    ).toEqual([
      'process:start',
      'sqlite-open:start',
      'sqlite-open:done',
      'source-read:start',
      'source-read:done',
      'digest:done',
      'blob-file-fsync:start',
      'blob-file-fsync:done',
      'blob-rename:done',
      'blob-dir-fsync:start',
      'blob-dir-fsync:done',
      'attachment-row-insert:start',
      'attachment-row-insert:done',
      'response-write:start',
      'response-write:done',
      'sqlite-close:start',
      'sqlite-close:done',
    ])
  })
})

describe('runBoundedCleanupPhases', () => {
  test('aggregates synchronous and asynchronous failures while running every later phase once', async () => {
    const calls: string[] = []
    const syncFailure = new Error('sync cleanup failed')
    const asyncFailure = new Error('async cleanup failed')

    const result = runBoundedCleanupPhases(
      [
        {
          phase: 'sync-cleanup',
          operation: () => {
            calls.push('sync')
            throw syncFailure
          },
        },
        {
          phase: 'async-cleanup',
          operation: async () => {
            calls.push('async')
            throw asyncFailure
          },
        },
        {
          phase: 'later-cleanup',
          operation: () => {
            calls.push('later')
          },
        },
      ],
      20_000
    )

    try {
      await result
      throw new Error('expected cleanup to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toMatchObject([
        { message: 'Cleanup phase sync-cleanup failed', cause: syncFailure },
        { message: 'Cleanup phase async-cleanup failed', cause: asyncFailure },
      ])
    }
    expect(calls).toEqual(['sync', 'async', 'later'])
  })

  test('orders thrown, rejected, and timed-out failures and continues after all of them', async () => {
    jest.useFakeTimers()
    const calls: string[] = []
    const result = runBoundedCleanupPhases(
      [
        {
          phase: 'thrown',
          operation: () => {
            calls.push('thrown')
            throw new Error('thrown failure')
          },
        },
        {
          phase: 'rejected',
          operation: () => {
            calls.push('rejected')
            return Promise.reject(new Error('rejected failure'))
          },
        },
        {
          phase: 'timed-out',
          operation: () => {
            calls.push('timed-out')
            return new Promise<never>(() => {})
          },
        },
        {
          phase: 'after-timeout',
          operation: () => {
            calls.push('after-timeout')
          },
        },
      ],
      20_000,
      10
    )

    // Let the two immediate failures settle so the timeout phase installs its timer.
    for (let turn = 0; turn < 20 && !calls.includes('timed-out'); turn++) await Promise.resolve()
    expect(calls).toContain('timed-out')
    jest.advanceTimersByTime(20_000)
    // Promise.race resolution may take multiple microtasks before the
    // post-abort join-grace timer is installed. Advance only after observing
    // that barrier; otherwise fake time can jump past a timer that does not
    // exist yet and leave the cleanup promise pending forever.
    for (let turn = 0; turn < 20 && jest.getTimerCount() === 0; turn++) await Promise.resolve()
    expect(jest.getTimerCount()).toBe(1)
    jest.advanceTimersByTime(10)

    try {
      await result
      throw new Error('expected cleanup to fail')
    } catch (error) {
      expect((error as AggregateError).errors).toMatchObject([
        { message: 'Cleanup phase thrown failed' },
        { message: 'Cleanup phase rejected failed' },
        { code: 'CLEANUP_PHASE_TIMEOUT', phase: 'timed-out' },
      ])
    }
    expect(calls).toEqual(['thrown', 'rejected', 'timed-out', 'after-timeout'])
    expect(jest.getTimerCount()).toBe(0)
  })

  test('times out an abort-ignoring phase and continues later cleanup phases', async () => {
    const completed: string[] = []
    const startedAt = Date.now()

    const cleanup = runBoundedCleanupPhases(
      [
        {
          phase: 'stuck-database-cleanup',
          operation: () => new Promise<never>(() => {}),
        },
        {
          phase: 'later-filesystem-cleanup',
          operation: () => {
            completed.push('later')
          },
        },
      ],
      10,
      5
    ).then(
      () => undefined,
      (error: unknown) => error
    )
    const didNotSettle = Symbol('cleanup-did-not-settle')
    let watchdog: Timer | undefined
    const outcome = await Promise.race([
      cleanup,
      new Promise<typeof didNotSettle>((resolve) => {
        watchdog = setTimeout(() => resolve(didNotSettle), 250)
      }),
    ])
    if (watchdog) clearTimeout(watchdog)

    expect(outcome).not.toBe(didNotSettle)
    expect(completed).toEqual(['later'])
    expect(Date.now() - startedAt).toBeLessThan(250)
    expect(outcome).toBeInstanceOf(AggregateError)
    expect((outcome as AggregateError).errors).toMatchObject([
      { code: 'CLEANUP_PHASE_TIMEOUT', phase: 'stuck-database-cleanup' },
    ])
  })
})

describe('runFileCapturedProcess', () => {
  test('captures stdout and stderr in files without pipe readers', async () => {
    const dir = await captureDir()

    const result = await runFileCapturedProcess(
      ['bun', '-e', `console.log('{"ok":true}'); console.error('diagnostic')`],
      { phase: 'cli-exit', timeoutMs: 2_000, captureDir: dir }
    )

    expect(result).toMatchObject({
      command: ['bun', '-e', `console.log('{"ok":true}'); console.error('diagnostic')`],
      exitCode: 0,
      stdout: '{"ok":true}\n',
      stderr: 'diagnostic\n',
    })
    expect(result.capturePaths).toHaveLength(2)
    for (const path of result.capturePaths!) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(dir)).toEqual([])
  })

  test('whoami child entrypoint, terminal output, and process exit are distinct', async () => {
    const cases = [
      { script: `setInterval(() => {}, 1_000)`, phase: 'amtp-cli:whoami:child-entrypoint' },
      {
        script: `console.error('entrypoint-ready'); setInterval(() => {}, 1_000)`,
        phase: 'amtp-cli:whoami:terminal-output',
      },
      {
        script: `console.error('entrypoint-ready'); console.log('{"instanceId":"i","registrations":[]}'); setInterval(() => {}, 1_000)`,
        phase: 'amtp-cli:whoami:process-exit',
      },
    ]
    for (const fixture of cases) {
      const dir = await captureDir()
      let error: unknown
      try {
        await runFileCapturedProcess(['bun', '-e', fixture.script], {
          phase: 'amtp-cli:whoami',
          timeoutMs: 100,
          captureDir: dir,
          entrypointReady: (_stdout, stderr) => stderr.includes('entrypoint-ready'),
          terminalOutput: (stdout) => stdout.includes('"instanceId":"i"'),
        })
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({ code: 'SUBPROCESS_PHASE_TIMEOUT', phase: fixture.phase })
      const ownership = error as {
        capturePaths: readonly string[]
        terminal: { exitCode: number | null; signalCode: string | null }
      }
      expect(ownership.capturePaths).toHaveLength(2)
      expect(ownership.terminal.exitCode !== null || ownership.terminal.signalCode !== null).toBe(true)
      for (const path of ownership.capturePaths) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(dir)).toEqual([])
    }
  })

  test('classifies an exited whoami child without its entrypoint marker', async () => {
    const dir = await captureDir()

    await expect(
      runFileCapturedProcess(['bun', '-e', `console.log('{"instanceId":"i","registrations":[]}')`], {
        phase: 'amtp-cli:whoami',
        timeoutMs: 2_000,
        captureDir: dir,
        entrypointReady: (_stdout, stderr) => stderr.includes('entrypoint-ready'),
        terminalOutput: (stdout) => stdout.includes('"instanceId":"i"'),
      })
    ).rejects.toMatchObject({
      code: 'SUBPROCESS_PHASE_FAILED',
      phase: 'amtp-cli:whoami:child-entrypoint',
    })
    expect(await readdir(dir)).toEqual([])
  })

  test('separates terminal output from process exit', async () => {
    const dir = await captureDir()
    const secret = 'attachment-body-must-not-leak'
    let error: unknown

    try {
      await runFileCapturedProcess(
        ['bun', '-e', `console.log(JSON.stringify({ attachmentId: 'att-1' })); setInterval(() => {}, 1_000)`],
        {
          phase: 'amtp-cli:attach-upload',
          timeoutMs: 100,
          captureDir: dir,
          terminalOutput: (stdout) => JSON.parse(stdout).attachmentId === 'att-1',
          diagnostics: async () => 'lastUploadPhase=response-written; nodeServe=alive',
        }
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({
      code: 'SUBPROCESS_PHASE_TIMEOUT',
      phase: 'amtp-cli:attach-upload:process-exit',
    })
    expect((error as Error).message).toContain('lastUploadPhase=response-written')
    expect((error as Error).message).not.toContain(secret)
    expect(() => process.kill((error as { pid: number }).pid, 0)).toThrow()
    expect(await readdir(dir)).toEqual([])
  })

  test('rejects a child that exits before terminal output', async () => {
    const dir = await captureDir()

    await expect(
      runFileCapturedProcess(['bun', '-e', `console.log('incomplete')`], {
        phase: 'amtp-cli:attach-upload',
        timeoutMs: 2_000,
        captureDir: dir,
        terminalOutput: () => false,
      })
    ).rejects.toMatchObject({
      code: 'SUBPROCESS_PHASE_FAILED',
      phase: 'amtp-cli:attach-upload:terminal-output',
    })
    expect(await readdir(dir)).toEqual([])
  })

  test('identifies a timeout before terminal output', async () => {
    const dir = await captureDir()

    await expect(
      runFileCapturedProcess(['bun', '-e', `setInterval(() => {}, 1_000)`], {
        phase: 'amtp-cli:attach-upload',
        timeoutMs: 100,
        captureDir: dir,
        terminalOutput: () => false,
      })
    ).rejects.toMatchObject({
      code: 'SUBPROCESS_PHASE_TIMEOUT',
      phase: 'amtp-cli:attach-upload:terminal-output',
    })
    expect(await readdir(dir)).toEqual([])
  })

  test('does not spawn after parent abort', async () => {
    const dir = await captureDir()
    const controller = new AbortController()
    controller.abort('cancelled before spawn')

    await expect(
      runFileCapturedProcess(['bun', '-e', `await Bun.write('${dir}/spawned', '')`], {
        phase: 'amtp-cli:pre-aborted',
        timeoutMs: 2_000,
        captureDir: dir,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'SUBPROCESS_PHASE_CANCELLED', phase: 'amtp-cli:pre-aborted' })
    expect(await readdir(dir)).toEqual([])
  })

  test('cancellation terminates the child and removes captures', async () => {
    const dir = await captureDir()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 25)
    let error: unknown

    try {
      await runFileCapturedProcess(['bun', '-e', `setInterval(() => {}, 1_000)`], {
        phase: 'amtp-cli:attach-upload',
        timeoutMs: 2_000,
        captureDir: dir,
        terminalOutput: () => false,
        signal: controller.signal,
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({ code: 'SUBPROCESS_PHASE_CANCELLED', phase: 'amtp-cli:attach-upload' })
    expect(() => process.kill((error as { pid: number }).pid, 0)).toThrow()
    expect(await readdir(dir)).toEqual([])
  })

  test('bounds diagnostics that do not settle', async () => {
    const dir = await captureDir()
    const startedAt = Date.now()
    let error: unknown

    try {
      await runFileCapturedProcess(['bun', '-e', `setInterval(() => {}, 1_000)`], {
        phase: 'amtp-cli:attach-upload',
        timeoutMs: 100,
        captureDir: dir,
        terminalOutput: () => false,
        diagnostics: () => new Promise<never>(() => {}),
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({ code: 'SUBPROCESS_PHASE_TIMEOUT' })
    expect((error as Error).message).toContain('diagnostic timed out')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(await readdir(dir)).toEqual([])
  })

  test('preserves timeout when diagnostics fail', async () => {
    const dir = await captureDir()

    let error: unknown
    try {
      await runFileCapturedProcess(['bun', '-e', `setInterval(() => {}, 1_000)`], {
        phase: 'amtp-cli:attach-upload',
        timeoutMs: 100,
        captureDir: dir,
        terminalOutput: () => false,
        diagnostics: () => {
          throw new Error('diagnostic exploded')
        },
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({
      code: 'SUBPROCESS_PHASE_TIMEOUT',
      phase: 'amtp-cli:attach-upload:terminal-output',
    })
    expect((error as Error).message).toContain('diagnostic failed')
    expect(await readdir(dir)).toEqual([])
  })

  test('terminates a timed-out child and reports its captured output', async () => {
    const dir = await captureDir()
    let error: unknown

    try {
      await runFileCapturedProcess(['bun', '-e', `console.log('started'); await Bun.sleep(10_000)`], {
        phase: 'cli-exit',
        timeoutMs: 100,
        captureDir: dir,
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({
      code: 'SUBPROCESS_PHASE_TIMEOUT',
      phase: 'cli-exit',
      command: ['bun', '-e', `console.log('started'); await Bun.sleep(10_000)`],
    })
    expect((error as Error).message).toContain('pid=')
    expect((error as Error).message).toContain('stdout tail=started')
    const pid = (error as { pid: number }).pid
    expect(() => process.kill(pid, 0)).toThrow()
    expect(await readdir(dir)).toEqual([])
  })
})

describe('readFileCapturedChildTails', () => {
  test('bounds long-lived diagnostic tails by UTF-8 bytes', async () => {
    const dir = await captureDir()
    const child = spawnFileCapturedChild(['bun', '-e', `console.log('🙂'.repeat(100))`], dir)
    await child.proc.exited

    try {
      const { stdout } = await readFileCapturedChildTails(child, 17)
      expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(17)
      expect(stdout).toEndWith('\n')
    } finally {
      await cleanupFileCapturedChild(child)
    }
  })
})

describe('waitForCapturedJsonLine', () => {
  test('reads the final capture after exit races an incomplete asynchronous read', async () => {
    const proc = { pid: 42, exitCode: null as number | null, signalCode: null }
    const child = { proc, stdoutPath: '', stderrPath: '' } as FileCapturedChild
    let reads = 0
    const record = await waitForCapturedJsonLine(child, {
      phase: 'final-capture-race',
      timeoutMs: 1_000,
      match: (value) => Boolean((value as { listening?: boolean })?.listening),
      readCaptures: async () => {
        reads++
        proc.exitCode = 0
        return { stdout: reads === 1 ? '{"listening":' : '{"listening":true}\n', stderr: '' }
      },
    })
    expect(reads).toBe(2)
    expect(record).toEqual({ listening: true })
  })

  test('waits for a matching newline-terminated record', async () => {
    const dir = await captureDir()
    const child = spawnFileCapturedChild(
      [
        'bun',
        '-e',
        `process.stdout.write('booting\\n{"listening":'); await Bun.sleep(25); console.log('true,"port":1234,"instanceId":"node"}')`,
      ],
      dir
    )

    try {
      const record = await waitForCapturedJsonLine<{ port: number; instanceId: string }>(child, {
        phase: 'node-listening-record',
        timeoutMs: 1_000,
        match: (value) =>
          typeof value === 'object' && value !== null && (value as { listening?: boolean }).listening === true,
      })
      expect(record).toMatchObject({ port: 1234, instanceId: 'node' })
    } finally {
      await child.proc.exited
      await cleanupFileCapturedChild(child)
    }
  })

  test('cancels a pending listening-record wait immediately', async () => {
    const dir = await captureDir()
    const controller = new AbortController()
    const child = spawnFileCapturedChild(['bun', '-e', `setInterval(() => {}, 1_000)`], dir)
    const wait = waitForCapturedJsonLine(child, {
      phase: 'node-listening-record',
      timeoutMs: 30_000,
      signal: controller.signal,
      match: () => false,
    })

    controller.abort('startup cancelled')
    await expect(wait).rejects.toMatchObject({
      code: 'SUBPROCESS_PHASE_CANCELLED',
      phase: 'node-listening-record',
    })
    await terminateProcess(child.proc)
    await cleanupFileCapturedChild(child)
    expect(await readdir(dir)).toEqual([])
  })

  test('fails in the listening phase when the child exits without a matching record', async () => {
    const dir = await captureDir()
    const child = spawnFileCapturedChild(['bun', '-e', `console.log('not-json')`], dir)

    try {
      await expect(
        waitForCapturedJsonLine(child, {
          phase: 'node-listening-record',
          timeoutMs: 1_000,
          match: () => false,
        })
      ).rejects.toMatchObject({ code: 'SUBPROCESS_PHASE_FAILED', phase: 'node-listening-record' })
    } finally {
      await cleanupFileCapturedChild(child)
    }
  })
})
