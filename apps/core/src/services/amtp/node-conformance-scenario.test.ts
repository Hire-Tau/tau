import { expect, test } from 'bun:test'
import { runBoundedScenarioTasks, ScenarioScope } from './node-conformance-scenario'

test('bounds shared-process task concurrency while preserving overlap', async () => {
  let active = 0
  let maxActive = 0
  const completed: number[] = []
  const tasks = Array.from({ length: 6 }, (_, index) => async () => {
    active++
    maxActive = Math.max(maxActive, active)
    await Promise.resolve()
    completed.push(index)
    active--
  })

  await runBoundedScenarioTasks(tasks, 2)

  expect(maxActive).toBe(2)
  expect(completed).toHaveLength(6)
  expect(completed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5])
})

test('disposes owned resources once in LIFO order', async () => {
  const calls: string[] = []
  const scope = new ScenarioScope('scenario-1')
  for (const id of ['row', 'file', 'child']) {
    scope.own({
      kind: 'test',
      id,
      dispose: async () => {
        calls.push(`dispose:${id}`)
      },
      assertGone: async () => {
        calls.push(`gone:${id}`)
      },
    })
  }

  await scope.dispose()
  await scope.dispose()
  expect(calls).toEqual(['dispose:child', 'gone:child', 'dispose:file', 'gone:file', 'dispose:row', 'gone:row'])
  expect(scope.snapshot()).toMatchObject({ resources: 0, operations: 0, aborted: true })
})

test('shares one in-flight disposal across concurrent callers', async () => {
  const calls: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const scope = new ScenarioScope('scenario-concurrent-dispose')
  scope.own({
    kind: 'resource',
    id: 'owned',
    dispose: async () => {
      calls.push('dispose:start')
      await gate
      calls.push('dispose:done')
    },
    assertGone: async () => {
      calls.push('gone')
    },
  })

  const first = scope.dispose()
  const second = scope.dispose()
  expect(second).toBe(first)
  await Promise.resolve()
  expect(calls).toEqual(['dispose:start'])
  release()
  await Promise.all([first, second])

  expect(calls).toEqual(['dispose:start', 'dispose:done', 'gone'])
})

test('rejects lifecycle registration after disposal starts', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const scope = new ScenarioScope('scenario-registration-fence')
  const completed = scope.operation('cli', 'completed')
  completed.complete()
  scope.own({
    kind: 'resource',
    id: 'owned',
    dispose: () => gate,
    assertGone: async () => {},
  })

  const disposal = scope.dispose()

  expect(() => scope.operation('cli', 'late')).toThrow('already disposing')
  expect(() => scope.track(completed, Promise.resolve())).toThrow('already disposing')
  expect(() => scope.own({ kind: 'late', id: 'late', dispose: async () => {}, assertGone: async () => {} })).toThrow(
    'already disposing'
  )
  release()
  await disposal
})

test('keeps resources owned until an allocated operation completes', async () => {
  const calls: string[] = []
  const scope = new ScenarioScope('scenario-operation', { cleanupTimeoutMs: 5 })
  const operation = scope.operation('cli', 'allocated-before-spawn')
  scope.own({
    kind: 'capture',
    id: 'owned',
    dispose: async () => {
      calls.push('resource:disposed')
    },
    assertGone: async () => {},
  })

  await expect(scope.dispose()).rejects.toThrow('operations did not settle')
  expect(calls).toEqual([])
  expect(scope.snapshot()).toMatchObject({ resources: 1, operations: 1, aborted: true })

  operation.complete()
  await scope.dispose()
  expect(calls).toEqual(['resource:disposed'])
  expect(scope.snapshot()).toMatchObject({ resources: 0, operations: 0, aborted: true })
})

test('joins aborted operations before disposing their resources', async () => {
  const calls: string[] = []
  const scope = new ScenarioScope('scenario-join')
  const operation = scope.operation('cli', 'pending')
  const pending = new Promise<void>((resolve) => {
    scope.signal.addEventListener(
      'abort',
      () => {
        calls.push('operation:closing')
        queueMicrotask(() => {
          calls.push('operation:closed')
          resolve()
        })
      },
      { once: true }
    )
  })
  void scope.track(operation, pending)
  scope.own({
    kind: 'capture',
    id: 'owned',
    dispose: async () => {
      calls.push('resource:disposed')
    },
    assertGone: async () => {},
  })

  await scope.dispose()

  expect(calls).toEqual(['operation:closing', 'operation:closed', 'resource:disposed'])
  expect(scope.snapshot()).toMatchObject({ resources: 0, operations: 0, aborted: true })
})

test('does not dispose resources when an operation misses the cleanup deadline', async () => {
  const calls: string[] = []
  let resolve!: () => void
  const scope = new ScenarioScope('scenario-join-timeout', { cleanupTimeoutMs: 5 })
  const operation = scope.operation('cli', 'stuck')
  const tracked = scope.track(
    operation,
    new Promise<void>((done) => {
      resolve = done
    })
  )
  scope.own({
    kind: 'capture',
    id: 'owned',
    dispose: async () => {
      calls.push('resource:disposed')
    },
    assertGone: async () => {},
  })

  await expect(scope.dispose()).rejects.toThrow('operations did not settle')
  expect(calls).toEqual([])
  resolve()
  await tracked
  await scope.dispose()
  expect(calls).toEqual(['resource:disposed'])
})

test('tracks a promise until it settles', async () => {
  const scope = new ScenarioScope('scenario-track')
  let resolve!: () => void
  const pending = new Promise<void>((done) => (resolve = done))
  const operation = scope.operation('cli', 'tracked')
  const tracked = scope.track(operation, pending)
  expect(scope.snapshot().operations).toBe(1)
  resolve()
  await tracked
  expect(scope.snapshot().operations).toBe(0)
  await scope.dispose()
})

test('uses a fresh cleanup signal after aborting execution', async () => {
  const scope = new ScenarioScope('scenario-cleanup-signal')
  let cleanupSignalAborted = true
  scope.own({
    kind: 'row',
    id: 'owned',
    dispose: async (signal) => {
      cleanupSignalAborted = signal.aborted
    },
    assertGone: async () => {},
  })
  await scope.dispose()
  expect(scope.signal.aborted).toBe(true)
  expect(cleanupSignalAborted).toBe(false)
})

test('cleans partial setup and aggregates cleanup failures', async () => {
  const calls: string[] = []
  const scope = new ScenarioScope('scenario-partial')

  await expect(
    scope.run(async () => {
      scope.own({
        kind: 'row',
        id: 'first',
        dispose: async () => {
          calls.push('first')
        },
        assertGone: async () => {},
      })
      scope.own({
        kind: 'file',
        id: 'second',
        dispose: async () => {
          calls.push('second')
          throw new Error('cleanup failed')
        },
        assertGone: async () => {},
      })
      throw new Error('setup failed')
    })
  ).rejects.toBeInstanceOf(AggregateError)
  expect(calls).toEqual(['second', 'first'])
  expect(scope.snapshot()).toMatchObject({ resources: 0, operations: 0, aborted: true })
})
