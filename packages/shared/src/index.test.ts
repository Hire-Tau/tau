import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('the browser-safe index does not export server-only OAuth subpaths', () => {
  const source = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')
  expect(source).not.toContain('oauth-providers')
  expect(source).not.toContain('oauth-broker')
})
