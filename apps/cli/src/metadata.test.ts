import { describe, expect, test } from 'bun:test'
import { buildMetadataDelta, getMetadataValue, parseMetadataPath, parseMetadataValue } from './metadata'

describe('metadata paths', () => {
  test('builds only the requested nested delta', () => {
    expect(buildMetadataDelta('ledger.current.sequence', 7)).toEqual({ ledger: { current: { sequence: 7 } } })
    expect(buildMetadataDelta('ledger.current.sequence', 7)).not.toHaveProperty('ledger.neighbor')
  })

  test.each(['', '.leading', 'trailing.', 'a..b'])('rejects empty path segments in %j', (path) => {
    expect(() => parseMetadataPath(path)).toThrow(`Invalid metadata path "${path}": path segments cannot be empty`)
  })

  test.each(['__proto__', 'prototype', 'constructor'])('rejects unsafe segment %s', (segment) => {
    expect(() => parseMetadataPath(`safe.${segment}`)).toThrow(
      `Invalid metadata path "safe.${segment}": unsafe path segment "${segment}"`
    )
  })

  test('supports hyphenated and numeric-looking object keys', () => {
    expect(buildMetadataDelta('ledger-key.0', true)).toEqual({ 'ledger-key': { '0': true } })
  })
})

describe('metadata values', () => {
  test.each([
    ['["a","b"]', ['a', 'b']],
    ['{"enabled":true}', { enabled: true }],
    ['-1.5', -1.5],
    ['false', false],
    ['null', null],
    ['"quoted"', 'quoted'],
    ['plain', 'plain'],
  ])('parses %s', (raw, expected) => {
    expect(parseMetadataValue(raw)).toEqual(expected)
  })
})

describe('getMetadataValue', () => {
  const metadata = { values: { false: false, zero: 0, empty: '', nil: null }, labels: ['a'] }

  test.each([
    ['values.false', false],
    ['values.zero', 0],
    ['values.empty', ''],
    ['values.nil', null],
  ])('returns present value at %s', (path, expected) => {
    expect(getMetadataValue(metadata, path)).toBe(expected)
  })

  test.each(['values.missing', 'labels.0', 'values.zero.child'])('rejects missing path %s', (path) => {
    expect(() => getMetadataValue(metadata, path)).toThrow(`Metadata path "${path}" not found`)
  })
})
