import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The provider adapter reaches the network, while the broker protocol is a deliberately
 * server-only boundary. Neither subpath may be pulled into the browser bundle.
 */
const FORBIDDEN = ['@tau/shared/oauth-providers', '@tau/shared/oauth-broker']

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(ts|tsx)$/.test(entry)) yield path
  }
}

describe('web bundle boundary', () => {
  test('apps/web imports no server-only shared subpath', () => {
    const offenders = [...sources(join(import.meta.dir, '../src'))].filter((path) => {
      const source = readFileSync(path, 'utf8')
      return FORBIDDEN.some((moduleName) => source.includes(moduleName))
    })
    expect(offenders).toEqual([])
  })

  test('the guard can actually fail (the scanner sees real files)', () => {
    expect([...sources(join(import.meta.dir, '../src'))].length).toBeGreaterThan(20)
  })
})
