import { describe, expect, test } from 'bun:test'
import { setQueryParamInPath } from './urlStateUtils'

describe('setQueryParamInPath', () => {
  test('sets a query param while preserving path and other params', () => {
    expect(setQueryParamInPath('/settings?section=providers', 'chat', 'open')).toBe(
      '/settings?section=providers&chat=open'
    )
  })

  test('removes a query param when value is null', () => {
    expect(setQueryParamInPath('/settings?section=providers&chat=open', 'chat', null)).toBe(
      '/settings?section=providers'
    )
  })

  test('preserves hash when changing query params', () => {
    expect(setQueryParamInPath('/settings?chat=open#providers', 'chat', 'expanded')).toBe(
      '/settings?chat=expanded#providers'
    )
  })
})
