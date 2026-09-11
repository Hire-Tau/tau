import { describe, expect, test } from 'bun:test'
import { amtpNodeCommand } from './node-conformance-command'

describe('amtpNodeCommand', () => {
  test('is used at both conformance child launch call sites', async () => {
    const source = await Bun.file(new URL('./node-conformance.test.ts', import.meta.url)).text()
    expect(source.match(/amtpNodeCommand\(process\.execPath, NODE_ENTRY/g)).toHaveLength(2)
    expect(source).not.toContain("['bun', 'run', NODE_ENTRY")
    expect(source).toContain('return establishNodeMailbox({ handle, inboundOpen: opts.open }')
  })

  test('uses the exact Bun executable and direct entrypoint without PATH or bun run', () => {
    expect(amtpNodeCommand('/exact/bun', '/installed/amtp/src/index.ts', ['--json', 'register', 'alice'])).toEqual([
      '/exact/bun',
      '/installed/amtp/src/index.ts',
      '--json',
      'register',
      'alice',
    ])
  })
})
