import { describe, expect, test } from 'bun:test'
import { deepMergeMetadata } from './metadata'

describe('deepMergeMetadata', () => {
  test('recursively merges objects, deletes null keys, and replaces arrays', () => {
    expect(
      deepMergeMetadata(
        { nested: { keep: true, remove: 'x' }, labels: ['old'], outside: 1 },
        { nested: { remove: null, add: 2 }, labels: ['new'] }
      )
    ).toEqual({ nested: { keep: true, add: 2 }, labels: ['new'], outside: 1 })
  })

  test('replaces primitives and objects when their shapes differ', () => {
    expect(deepMergeMetadata({ object: { old: true }, scalar: 1 }, { object: false, scalar: { new: true } })).toEqual({
      object: false,
      scalar: { new: true },
    })
  })

  test('treats prototype-named keys as own data properties', () => {
    const delta = JSON.parse('{"__proto__":{"safe":true},"constructor":"value"}') as Record<string, unknown>
    const result = deepMergeMetadata({ neighbor: 'keep' }, delta)

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true)
    expect(result.__proto__).toEqual({ safe: true })
    expect(result['constructor']).toBe('value')
    expect(result.neighbor).toBe('keep')
  })
})
