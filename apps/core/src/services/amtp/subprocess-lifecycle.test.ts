import { describe, expect, test } from 'bun:test'
import { terminateProcess } from './subprocess-lifecycle'

describe('terminateProcess', () => {
  test('treats a rejected exit observation as terminated', async () => {
    const signals: string[] = []
    const proc = {
      exited: Promise.reject(new Error('exit observation rejected')),
      kill(signal: string) {
        signals.push(signal)
      },
    }

    await expect(terminateProcess(proc)).resolves.toBeUndefined()
    expect(signals).toEqual(['SIGTERM'])
  })

  test('bounds cleanup when exit observation stays unresolved after SIGKILL', async () => {
    const signals: string[] = []
    const proc = {
      exited: new Promise<never>(() => {}),
      kill(signal: string) {
        signals.push(signal)
      },
    }

    await expect(terminateProcess(proc, 500, async () => {}, 500)).rejects.toMatchObject({
      code: 'SUBPROCESS_TERMINATION_UNOBSERVED',
      phase: 'sigkill-exit',
    })
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  test('escalates a stuck CLI subprocess and waits for cleanup', async () => {
    let resolveExit!: () => void
    const exited = new Promise<void>((resolve) => (resolveExit = resolve))
    const signals: string[] = []
    const proc = {
      exited,
      kill(signal: string) {
        signals.push(signal)
        if (signal === 'SIGKILL') resolveExit()
      },
    }

    await terminateProcess(proc, 500, async (ms) => {
      expect(ms).toBe(500)
    })

    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})
