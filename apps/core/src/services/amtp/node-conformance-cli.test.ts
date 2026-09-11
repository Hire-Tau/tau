import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runScopedCliProcess } from './node-conformance-cli'
import { runFileCapturedProcess } from './node-conformance-process'
import { ScenarioScope } from './node-conformance-scenario'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('runScopedCliProcess', () => {
  test('scope abort cancels and joins a hung nonexistent-recipient child before resource disposal', async () => {
    const captureDir = await mkdtemp(join(tmpdir(), 'amtp-scoped-cli-'))
    temporaryDirectories.push(captureDir)
    const scope = new ScenarioScope('concurrent-nonexistent-recipient', { cleanupTimeoutMs: 1_000 })
    const operation = scope.operation('cli', 'amtp-cli:send-nonexistent')
    let childError: unknown
    let disposed = false

    const cliProcess = runScopedCliProcess({
      scope,
      operation,
      run: (signal) =>
        runFileCapturedProcess(['bun', '-e', 'setInterval(() => {}, 1_000)'], {
          phase: 'amtp-cli:send-nonexistent',
          timeoutMs: 250,
          captureDir,
          signal,
        }).catch((error: unknown) => {
          childError = error
          throw error
        }),
    })
    const settledProcess = cliProcess.catch((error: unknown) => error)

    scope.own({
      kind: 'nonexistent-recipient-fixture',
      id: 'sentinel',
      dispose: async () => {
        expect(childError).toMatchObject({
          code: 'SUBPROCESS_PHASE_CANCELLED',
          phase: 'amtp-cli:send-nonexistent',
        })
        expect(() => process.kill((childError as { pid: number }).pid, 0)).toThrow()
        expect(await readdir(captureDir)).toEqual([])
        expect(scope.snapshot().operations).toBe(0)
        disposed = true
      },
      assertGone: async () => expect(disposed).toBe(true),
    })

    const disposal = scope.dispose()
    const [error] = await Promise.all([settledProcess, disposal])

    expect(error).toMatchObject({
      code: 'SUBPROCESS_PHASE_CANCELLED',
      phase: 'amtp-cli:send-nonexistent',
    })
    expect(scope.snapshot()).toEqual({ resources: 0, operations: 0, aborted: true })
  })
})
