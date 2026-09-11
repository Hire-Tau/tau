import { describe, expect, it, afterEach } from 'bun:test'
import {
  PeriodicRunner,
  createPeriodicRunner,
  listPeriodicRunnerNames,
  stopAllPeriodicRunners,
  type PeriodicRunnerLogger,
} from './periodic-runner'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('PeriodicRunner', () => {
  let runners: PeriodicRunner[] = []

  afterEach(async () => {
    for (const runner of runners) {
      await runner.stop()
    }
    runners = []
  })

  function track(runner: PeriodicRunner) {
    runners.push(runner)
    return runner
  }

  describe('abstract class via subclass', () => {
    it('runs task immediately by default on start', async () => {
      let count = 0
      class TestRunner extends PeriodicRunner {
        protected async runTask() {
          count++
        }
      }

      const runner = track(new TestRunner({ name: 'test', intervalMs: 1000 }))
      runner.start()
      await sleep(50)
      expect(count).toBe(1)
    })

    it('skips immediate run when runImmediately is false', async () => {
      let count = 0
      class TestRunner extends PeriodicRunner {
        protected async runTask() {
          count++
        }
      }

      const runner = track(new TestRunner({ name: 'test', intervalMs: 1000, runImmediately: false }))
      runner.start()
      await sleep(50)
      expect(count).toBe(0)
    })
  })

  describe('createPeriodicRunner', () => {
    it('runs task on interval', async () => {
      let count = 0
      let resolveSecondRun: () => void
      const secondRun = new Promise<void>((resolve) => {
        resolveSecondRun = resolve
      })
      const runner = track(
        createPeriodicRunner({
          name: 'counter',
          intervalMs: 50,
          runImmediately: false,
          task: async () => {
            count++
            if (count === 2) resolveSecondRun()
          },
        })
      )

      runner.start()
      await secondRun
      expect(count).toBeGreaterThanOrEqual(2)
    })

    it('runs immediately then on interval', async () => {
      let count = 0
      const runner = track(
        createPeriodicRunner({
          name: 'immediate',
          intervalMs: 100,
          task: async () => {
            count++
          },
        })
      )

      runner.start()
      await sleep(10)
      expect(count).toBe(1) // immediate run

      await sleep(150)
      expect(count).toBeGreaterThanOrEqual(2) // interval kicked in
    })

    it('stops running on stop()', async () => {
      let count = 0
      const runner = track(
        createPeriodicRunner({
          name: 'stoppable',
          intervalMs: 30,
          runImmediately: false,
          task: async () => {
            count++
          },
        })
      )

      runner.start()
      await sleep(80)
      const countAtStop = count
      expect(countAtStop).toBeGreaterThanOrEqual(1)

      await runner.stop()
      await sleep(80)
      expect(count).toBe(countAtStop) // no more runs after stop
    })
  })

  describe('concurrent execution guard', () => {
    it('prevents concurrent runs', async () => {
      let concurrency = 0
      let maxConcurrency = 0

      const runner = track(
        createPeriodicRunner({
          name: 'no-overlap',
          intervalMs: 20,
          runImmediately: false,
          task: async () => {
            concurrency++
            maxConcurrency = Math.max(maxConcurrency, concurrency)
            await sleep(60)
            concurrency--
          },
        })
      )

      runner.start()
      await sleep(150)
      await runner.stop()
      expect(maxConcurrency).toBe(1)
    })

    it('trigger() skips if already running', async () => {
      let runCount = 0
      const runner = track(
        createPeriodicRunner({
          name: 'trigger-guard',
          intervalMs: 10000,
          runImmediately: false,
          task: async () => {
            runCount++
            await sleep(100)
          },
        })
      )

      // Start a trigger, then immediately try another
      const p1 = runner.trigger()
      expect(runner.isRunning()).toBe(true)

      const p2 = runner.trigger() // should skip
      await Promise.all([p1, p2])
      expect(runCount).toBe(1)
    })
  })

  describe('trigger()', () => {
    it('runs task manually', async () => {
      let count = 0
      const runner = track(
        createPeriodicRunner({
          name: 'manual',
          intervalMs: 10000,
          runImmediately: false,
          task: async () => {
            count++
          },
        })
      )

      await runner.trigger()
      expect(count).toBe(1)

      await runner.trigger()
      expect(count).toBe(2)
    })
  })

  describe('isRunning()', () => {
    it('returns false when not running', () => {
      const runner = track(
        createPeriodicRunner({
          name: 'check',
          intervalMs: 1000,
          runImmediately: false,
          task: async () => {},
        })
      )
      expect(runner.isRunning()).toBe(false)
    })

    it('returns true during task execution', async () => {
      let resolveTask: () => void
      const taskPromise = new Promise<void>((r) => {
        resolveTask = r
      })

      const runner = track(
        createPeriodicRunner({
          name: 'running-check',
          intervalMs: 10000,
          runImmediately: false,
          task: async () => {
            await taskPromise
          },
        })
      )

      const triggerPromise = runner.trigger()
      await sleep(10)
      expect(runner.isRunning()).toBe(true)

      resolveTask!()
      await triggerPromise
      expect(runner.isRunning()).toBe(false)
    })
  })

  describe('error handling', () => {
    it('continues running after task errors', async () => {
      let count = 0
      let resolveSecondRun: () => void
      const secondRun = new Promise<void>((resolve) => {
        resolveSecondRun = resolve
      })
      const runner = track(
        createPeriodicRunner({
          name: 'error-resilient',
          intervalMs: 30,
          runImmediately: false,
          task: async () => {
            count++
            if (count === 1) throw new Error('first run fails')
            if (count === 2) resolveSecondRun()
          },
        })
      )

      runner.start()
      await secondRun
      await runner.stop()
      expect(count).toBeGreaterThanOrEqual(2) // kept running after error
    })

    it('resets running flag after error', async () => {
      const runner = track(
        createPeriodicRunner({
          name: 'error-reset',
          intervalMs: 10000,
          runImmediately: false,
          task: async () => {
            throw new Error('boom')
          },
        })
      )

      await runner.trigger()
      expect(runner.isRunning()).toBe(false)
    })

    it('reports task errors through the injected logger', async () => {
      const errors: unknown[][] = []
      const logger: PeriodicRunnerLogger = {
        error: (...args) => errors.push(args),
      }

      const runner = track(
        createPeriodicRunner({
          name: 'logged-error',
          intervalMs: 10000,
          runImmediately: false,
          logger,
          task: async () => {
            throw new Error('logged boom')
          },
        })
      )

      await runner.trigger()
      expect(errors.length).toBe(1)
      expect(errors[0][0]).toContain('logged-error')
    })

    it('falls back to a console-shaped default logger when none is injected', async () => {
      const runner = track(
        createPeriodicRunner({
          name: 'default-logger',
          intervalMs: 10000,
          runImmediately: false,
          task: async () => {
            throw new Error('unlogged boom')
          },
        })
      )

      // Should not throw synchronously and should not reject — errors are
      // swallowed by the default console-shaped logger, same as before.
      await expect(runner.trigger()).resolves.toBeUndefined()
    })
  })

  describe('stop()', () => {
    it('waits for in-flight task to complete', async () => {
      let taskCompleted = false
      const runner = track(
        createPeriodicRunner({
          name: 'wait-stop',
          intervalMs: 10000,
          task: async () => {
            await sleep(80)
            taskCompleted = true
          },
        })
      )

      runner.start()
      await sleep(10) // let the immediate run start
      expect(runner.isRunning()).toBe(true)

      await runner.stop()
      expect(taskCompleted).toBe(true)
    })

    it('is idempotent', async () => {
      const runner = track(
        createPeriodicRunner({
          name: 'double-stop',
          intervalMs: 1000,
          runImmediately: false,
          task: async () => {},
        })
      )

      runner.start()
      await runner.stop()
      await runner.stop() // should not throw
    })

    it('start() is idempotent when already started', async () => {
      let count = 0
      const runner = track(
        createPeriodicRunner({
          name: 'double-start',
          intervalMs: 30,
          runImmediately: false,
          task: async () => {
            count++
          },
        })
      )

      runner.start()
      runner.start() // should not create second timer
      await sleep(80)
      await runner.stop()
      // If two timers were created, count would be roughly double
      expect(count).toBeLessThanOrEqual(3)
    })
  })

  describe('registry', () => {
    it('registers on start and unregisters on stop', async () => {
      const runner = track(createPeriodicRunner({ name: 'registry-test-a', intervalMs: 60_000, task: async () => {} }))

      expect(listPeriodicRunnerNames()).not.toContain('registry-test-a')
      runner.start()
      expect(listPeriodicRunnerNames()).toContain('registry-test-a')
      await runner.stop()
      expect(listPeriodicRunnerNames()).not.toContain('registry-test-a')
    })

    it('stopAllPeriodicRunners stops every started runner', async () => {
      let aRuns = 0
      let bRuns = 0
      const a = track(
        createPeriodicRunner({
          name: 'registry-test-b',
          intervalMs: 20,
          runImmediately: false,
          task: async () => {
            aRuns++
          },
        })
      )
      const b = track(
        createPeriodicRunner({
          name: 'registry-test-c',
          intervalMs: 20,
          runImmediately: false,
          task: async () => {
            bRuns++
          },
        })
      )
      a.start()
      b.start()
      await sleep(50)
      expect(aRuns).toBeGreaterThan(0)
      expect(bRuns).toBeGreaterThan(0)

      await stopAllPeriodicRunners()
      expect(listPeriodicRunnerNames()).not.toContain('registry-test-b')
      expect(listPeriodicRunnerNames()).not.toContain('registry-test-c')

      const aRunsAfter = aRuns
      const bRunsAfter = bRuns
      await sleep(60)
      expect(aRuns).toBe(aRunsAfter)
      expect(bRuns).toBe(bRunsAfter)
    })

    it('a never-started runner is not registered', () => {
      track(createPeriodicRunner({ name: 'registry-test-d', intervalMs: 60_000, task: async () => {} }))
      expect(listPeriodicRunnerNames()).not.toContain('registry-test-d')
    })
  })
})
