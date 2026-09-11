import { describe, expect, test } from 'bun:test'
import { mergeDefined } from './mergeDefined'

describe('mergeDefined', () => {
  test('applies defined overrides without allowing undefined to erase defaults', () => {
    const first = () => 'real-first'
    const second = () => 'real-second'
    const replacement = () => 'replacement'

    const merged = mergeDefined({ first, second }, { first: undefined, second: replacement } as Partial<{
      first: typeof first
      second: typeof second
    }>)

    expect(merged.first).toBe(first)
    expect(merged.second).toBe(replacement)
  })

  test('does not mutate defaults or overrides', () => {
    const defaults = { value: 1 }
    const overrides = { value: 2 }
    const merged = mergeDefined(defaults, overrides)

    expect(merged).toEqual({ value: 2 })
    expect(defaults).toEqual({ value: 1 })
    expect(overrides).toEqual({ value: 2 })
  })
})
