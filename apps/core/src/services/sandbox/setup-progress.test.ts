import { describe, expect, test } from 'bun:test'
import type { ISandboxManager } from './types'
import {
  beginSandboxSetupWork,
  observeSandboxSetupProgress,
  trackSandboxSetupWork,
  type SandboxSetupProgressEvent,
} from './setup-progress'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('sandbox setup progress', () => {
  test('publishes unique start and finish events in order', () => {
    const manager = {} as ISandboxManager
    const events: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(manager, 'agent_a', (event) => events.push(event))

    const finishFirst = beginSandboxSetupWork(manager, 'agent_a', 'runtime_start')
    const finishSecond = beginSandboxSetupWork(manager, 'agent_a', 'asset_reconcile')
    finishSecond('ready')
    finishFirst('ready')

    expect(events.map((event) => event.type)).toEqual(['started', 'started', 'finished', 'finished'])
    expect(events[0]?.operationId).not.toBe(events[1]?.operationId)
    expect(events[2]?.operationId).toBe(events[1]?.operationId)
    expect(events[3]?.operationId).toBe(events[0]?.operationId)
  })

  test('manual finish is idempotent', () => {
    const manager = {} as ISandboxManager
    const events: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(manager, 'agent_a', (event) => events.push(event))

    const finish = beginSandboxSetupWork(manager, 'agent_a', 'runtime_reconnect')
    finish('ready')
    finish('failed')

    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ type: 'finished', outcome: 'ready' })
  })

  test('tracks nested work independently', async () => {
    const manager = {} as ISandboxManager
    const events: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(manager, 'agent_a', (event) => events.push(event))

    await trackSandboxSetupWork(manager, 'agent_a', 'runtime_start', () =>
      trackSandboxSetupWork(manager, 'agent_a', 'setup_reconcile', async () => undefined)
    )

    expect(events.map((event) => event.type)).toEqual(['started', 'started', 'finished', 'finished'])
    expect(events[2]?.operationId).toBe(events[1]?.operationId)
    expect(events[3]?.operationId).toBe(events[0]?.operationId)
  })

  test('reports failure and rethrows the original error', async () => {
    const manager = {} as ISandboxManager
    const events: SandboxSetupProgressEvent[] = []
    const error = new Error('setup failed')
    observeSandboxSetupProgress(manager, 'agent_a', (event) => events.push(event))

    const result = trackSandboxSetupWork(manager, 'agent_a', 'runtime_start', async () => {
      throw error
    })

    await expect(result).rejects.toBe(error)
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'failed' })
  })

  test('replays active setup work to a concurrent joiner', async () => {
    const manager = {} as ISandboxManager
    const release = deferred<void>()
    const first: SandboxSetupProgressEvent[] = []
    const joined: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(manager, 'agent_a', (event) => first.push(event))

    const work = trackSandboxSetupWork(manager, 'agent_a', 'runtime_start', () => release.promise)
    observeSandboxSetupProgress(manager, 'agent_a', (event) => joined.push(event))

    expect(joined[0]).toMatchObject({ type: 'started', sandboxId: 'agent_a' })
    release.resolve()
    await work
    expect(joined.at(-1)).toMatchObject({ type: 'finished', outcome: 'ready' })
    expect(joined[0]!.operationId).toBe(joined.at(-1)!.operationId)
  })
})
