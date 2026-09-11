import { randomUUID } from 'node:crypto'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { createLogger, installConsoleContentSanitizer, setLogContentSanitizer } from '../../lib/infra/logger'
import { ContentSafety } from './content-safety'

afterEach(() => setLogContentSanitizer(undefined))

test('sanitizes exact values and nested errors before the console sink', () => {
  const canary = `CANARY_SECRET_${randomUUID()}`
  const safety = ContentSafety.fromSecretEntries([{ key: 'TEST_KEY', value: canary }])
  setLogContentSanitizer((args) => safety.redact(args))
  const captured: unknown[][] = []
  const consoleSpy = spyOn(console, 'error').mockImplementation((...args) => {
    captured.push(args)
  })
  const restoreConsole = installConsoleContentSanitizer()

  try {
    createLogger('security-test').error('generated failure', new Error(canary), { nested: canary })
    console.error('direct generated failure', { nested: canary })
  } finally {
    restoreConsole()
    consoleSpy.mockRestore()
  }

  expect(JSON.stringify(captured)).not.toContain(canary)
  expect(JSON.stringify(captured)).toContain('[REDACTED_SECRET_ENV:TEST_KEY]')
})

test('sanitizes every Console output method and restores nested layers out of order', () => {
  const canary = `CANARY_SECRET_${randomUUID()}`
  setLogContentSanitizer((args) => ContentSafety.fromSecretEntries([{ key: 'TEST_KEY', value: canary }]).redact(args))
  const methods = ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir'] as const
  const captured: unknown[][] = []
  const spies = methods.map((method) =>
    spyOn(console, method as 'log').mockImplementation((...args: unknown[]) => captured.push(args))
  )
  const spiedLog = console.log
  const restoreFirst = installConsoleContentSanitizer()
  const restoreSecond = installConsoleContentSanitizer()
  try {
    for (const method of methods) (console[method] as (...args: unknown[]) => void)({ nested: canary })
    restoreFirst()
    console.info({ nested: canary })
    restoreSecond()
    expect(console.log).toBe(spiedLog)
  } finally {
    restoreSecond()
    restoreFirst()
    for (const spy of spies.reverse()) spy.mockRestore()
  }
  expect(JSON.stringify(captured)).not.toContain(canary)
  expect(JSON.stringify(captured)).toContain('[REDACTED_SECRET_ENV:TEST_KEY]')
})

test('degrades unsupported console arguments individually while preserving safe diagnostics', () => {
  const captured: unknown[][] = []
  const consoleSpy = spyOn(console, 'log').mockImplementation((...args) => captured.push(args))
  const restoreConsole = installConsoleContentSanitizer()
  try {
    createLogger('security-test').info(
      'awaiting',
      Promise.resolve('safe'),
      new Headers({ 'x-generated': 'safe' }),
      new URLSearchParams({ status: 'ready' }),
      AbortSignal.abort()
    )
  } finally {
    restoreConsole()
    consoleSpy.mockRestore()
  }

  const serialized = JSON.stringify(captured)
  expect(serialized).toContain('awaiting')
  expect(serialized).toContain('[Promise]')
  expect(serialized).toContain('x-generated')
  expect(serialized).toContain('status=ready')
  expect(serialized).toContain('aborted')
  expect(serialized).not.toBe('[REDACTED_LOG_CONTENT]')
})
