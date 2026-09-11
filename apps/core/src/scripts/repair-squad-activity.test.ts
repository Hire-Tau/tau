import { describe, expect, mock, spyOn, test } from 'bun:test'
import { parseActivityRepairArgs, runActivityRepairCli } from './repair-squad-activity'

const from = '2026-08-01T00:00:00.000Z'
const to = '2026-08-02T00:00:00.000Z'
const valid = ['--from', from, '--to', to]
const report = { groups: 0, changed: 0, inserted: 0, updated: 0, deleted: 0, errors: 0, families: {} } as any

describe('Activity repair CLI', () => {
  test('strictly validates flags and window before acquiring the repair lease', async () => {
    expect(parseActivityRepairArgs(valid)).toEqual({ from: new Date(from), to: new Date(to) })
    expect(parseActivityRepairArgs([...valid, '--wait', '10', '--concurrency', '2'])).toEqual({
      from: new Date(from),
      to: new Date(to),
      waitMs: 10 * 60_000,
      concurrency: 2,
    })
    const invalid = [
      [],
      ['--from', from],
      ['--from', from, '--from', from, '--to', to],
      ['--wat', from, '--to', to],
      ['--from', '2026-08-01', '--to', to],
      ['--from', to, '--to', from],
      ['--from', from, '--to', '2026-09-02T00:00:00.000Z'],
      [...valid, '--wait', '0'],
      [...valid, '--wait', 'soon'],
      [...valid, '--concurrency', '17'],
      [...valid, '--concurrency', '1.5'],
    ]
    for (const args of invalid) {
      const run = mock(async () => report)
      expect(await runActivityRepairCli(args, run)).toBe(1)
      expect(run).not.toHaveBeenCalled()
    }
  })

  test('a held lease without --wait fails with guidance; --wait retries until acquired', async () => {
    const stderr = spyOn(console, 'error').mockImplementation(() => undefined)
    const stdout = spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      // No --wait: single attempt, actionable failure message.
      const single = mock(async () => null)
      expect(await runActivityRepairCli(valid, single as any)).toBe(1)
      expect(single).toHaveBeenCalledTimes(1)
      expect(stderr.mock.calls.some(([line]) => String(line).includes('--wait'))).toBe(true)

      // --wait: retries (fast seam interval) until the lease frees, then succeeds.
      let attempts = 0
      const eventuallyFree = mock(async () => (++attempts < 3 ? null : report))
      expect(await runActivityRepairCli([...valid, '--wait', '5'], eventuallyFree as any, 1)).toBe(0)
      expect(eventuallyFree).toHaveBeenCalledTimes(3)

      // --concurrency is threaded through to the repair input.
      const sawConcurrency = mock(async (input: any) => {
        expect(input.concurrency).toBe(2)
        return report
      })
      expect(await runActivityRepairCli([...valid, '--concurrency', '2'], sawConcurrency as any)).toBe(0)
    } finally {
      stderr.mockRestore()
      stdout.mockRestore()
    }
  })

  test('returns failure and emits structured diagnostics for a partial report', async () => {
    const stdout = spyOn(console, 'log').mockImplementation(() => undefined)
    const stderr = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const partial = {
        ...report,
        errors: 1,
        families: {
          chat: {
            pages: 1,
            groups: 1,
            changed: 0,
            inserted: 0,
            updated: 0,
            deleted: 0,
            errors: 1,
            failures: [{ phase: 'materialize', groupId: 'bad', message: 'invalid uuid' }],
          },
        },
      }
      expect(await runActivityRepairCli(valid, async () => partial)).toBe(1)
      expect(JSON.parse(stdout.mock.calls.at(-1)?.[0] as string)).toMatchObject({ errors: 1 })
      expect(stderr.mock.calls.some(([line]) => String(line).includes('activity_repair_partial_failure'))).toBe(true)
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
    }
  })

  test('uses the shared repair lease and aborts on SIGTERM', async () => {
    // process.emit('SIGTERM') invokes EVERY registered listener in this shared
    // bun test process, not just the CLI's — an app module loaded by an earlier
    // file that registers a process-level shutdown handler (worker.ts once did,
    // at module scope) would run its full shutdown and process.exit(0) here,
    // killing the rest of the suite with a success code. Detach foreign
    // listeners around the emit so only the CLI's own handler fires.
    const foreignTerm = process.listeners('SIGTERM')
    const foreignInt = process.listeners('SIGINT')
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    try {
      const run = mock(async (input: any) => {
        expect(input.task).toBe('repair')
        return new Promise<any>((resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
          queueMicrotask(() => process.emit('SIGTERM'))
        })
      })
      expect(await runActivityRepairCli(valid, run)).toBe(1)
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      for (const listener of foreignTerm) process.on('SIGTERM', listener as NodeJS.SignalsListener)
      for (const listener of foreignInt) process.on('SIGINT', listener as NodeJS.SignalsListener)
    }
  })
})
