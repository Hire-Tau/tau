import { expect, test } from 'bun:test'
import { LifecycleLedger, ManualLifecycleClock, deadlineAt, zeroLifecycleSnapshot } from './node-conformance-lifecycle'

test('abort settles a pending wait and removes its timer and listener', async () => {
  const clock = new ManualLifecycleClock()
  const ledger = new LifecycleLedger()
  const controller = new AbortController()
  const wait = clock.sleep(20_000, controller.signal, ledger)

  controller.abort('scenario cancelled')
  await expect(wait).rejects.toMatchObject({ name: 'AbortError' })
  expect(clock.pendingCount()).toBe(0)
  expect(ledger.snapshot()).toEqual(zeroLifecycleSnapshot)
})

test('child deadlines never renew the parent budget', () => {
  const clock = new ManualLifecycleClock()
  const parent = deadlineAt(clock, 1_000)
  expect(parent.child(20_000).expiresAt).toBe(1_000)
  clock.advanceBy(700)
  expect(parent.child(20_000, 100).remainingMs()).toBe(200)
})

test('ledger tracks children and unique operations idempotently', () => {
  const ledger = new LifecycleLedger()
  const releaseChild = ledger.registerChild()
  const releaseOperation = ledger.registerOperation('operation-1')
  expect(ledger.snapshot()).toMatchObject({ children: 1, operations: ['operation-1'] })
  expect(() => ledger.registerOperation('operation-1')).toThrow('duplicate lifecycle operation')
  releaseOperation()
  releaseOperation()
  releaseChild()
  releaseChild()
  expect(ledger.snapshot()).toEqual(zeroLifecycleSnapshot)
})

test('manual clock settles due waits and releases resources', async () => {
  const clock = new ManualLifecycleClock()
  const ledger = new LifecycleLedger()
  const wait = clock.sleep(50, new AbortController().signal, ledger)
  clock.advanceBy(50)
  await wait
  expect(clock.pendingCount()).toBe(0)
  expect(ledger.snapshot()).toEqual(zeroLifecycleSnapshot)
})
