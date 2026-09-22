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
  expect((await first)?.value).toBe(42)
  expect(await second).toBe(await first)
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
  expect((await read)?.value).toBeUndefined()
})

test('automatic scheduling honors the coalescing deadline after a manual attempt', async () => {
  const lease = acquireSilentRecovery<number>({}, 'a/e')
  try {
    await lease.recovery.read(12000, true, async () => 1)
    expect(lease.recovery.delay(15000, 0)).toBe(1000)
    expect(lease.recovery.delay(16000, 0)).toBe(0)
  } finally {
    lease.release()
  }
})

test('a rejected shared attempt owns one history fallback even for cached consumers', async () => {
  const lease = acquireSilentRecovery<number>({}, 'a/e')
  let refreshes = 0
  try {
    const read = () => Promise.reject(new Error('offline'))
    const first = lease.recovery.read(0, true, read, () => refreshes++)
    const second = lease.recovery.read(0, true, read, () => refreshes++)
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(a?.value).toBeUndefined()
    a?.refresh()
    b?.refresh()
    const cached = await lease.recovery.read(100, true, read, () => refreshes++)
    expect(cached).toBe(a)
    cached?.refresh()
    expect(refreshes).toBe(1)
  } finally {
    lease.release()
  }
})
