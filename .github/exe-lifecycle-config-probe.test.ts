import { expect, test } from 'bun:test'

test('macOS lifecycle harness loaded .github/bunfig.toml', () => {
  expect((globalThis as typeof globalThis & { __exeLifecycleCiConfig?: string }).__exeLifecycleCiConfig).toBe(
    'preload:maxConcurrency=1'
  )
})
