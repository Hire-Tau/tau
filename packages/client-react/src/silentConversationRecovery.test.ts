import { expect, test } from 'bun:test'
import { acquireSilentRecovery } from './silentConversationRecovery'

test('simultaneous observers share pending exact read and its causal result', async () => {
  const owner = {}
  const a = acquireSilentRecovery<number>(owner, 'a/e')
  const b = acquireSilentRecovery<number>(owner, 'a/e')
  let resolve!: (n: number) => void
  let reads = 0
  const read = () => {
    reads++
    return new Promise<number>((r) => {
      resolve = r
    })
  }
  const first = a.recovery.read(100, false, read)
  const second = b.recovery.read(100, true, read)
  expect(reads).toBe(1)
  resolve(42)
  expect(await first).toBe(42)
  expect(await second).toBe(42)
  expect(a.recovery.delay(100, 100)).toBe(30000)
  a.release()
  b.release()
})

test('last observer release aborts a pending read, not another observer subscription', async () => {
  const owner = {}
  const a = acquireSilentRecovery<number>(owner, 'a/e')
  const b = acquireSilentRecovery<number>(owner, 'a/e')
  let signal!: AbortSignal
  const read = a.recovery.read(0, false, async (s) => {
    signal = s
    return new Promise<number>(() => {})
  })
  a.release()
  expect(signal.aborted).toBe(false)
  b.release()
  expect(signal.aborted).toBe(true)
  expect(await read).toBeUndefined()
})
