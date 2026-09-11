import { beforeEach, describe, expect, test } from 'bun:test'
import {
  clearHostWorkspaceOverrides,
  getHostWorkspaceOverride,
  replaceHostWorkspaceOverrides,
  setHostWorkspaceOverride,
} from './workspace-overrides'

describe('host workspace overrides cache', () => {
  beforeEach(() => clearHostWorkspaceOverrides())

  test('set / get / clear with null', () => {
    expect(getHostWorkspaceOverride('s1')).toBeUndefined()
    setHostWorkspaceOverride('s1', '/srv/repo')
    expect(getHostWorkspaceOverride('s1')).toBe('/srv/repo')
    setHostWorkspaceOverride('s1', null)
    expect(getHostWorkspaceOverride('s1')).toBeUndefined()
  })

  test('replace swaps the whole table', () => {
    setHostWorkspaceOverride('old', '/old')
    replaceHostWorkspaceOverrides([
      { squadId: 'a', path: '/a' },
      { squadId: 'b', path: '/b' },
    ])
    expect(getHostWorkspaceOverride('old')).toBeUndefined()
    expect(getHostWorkspaceOverride('a')).toBe('/a')
    expect(getHostWorkspaceOverride('b')).toBe('/b')
  })
})
