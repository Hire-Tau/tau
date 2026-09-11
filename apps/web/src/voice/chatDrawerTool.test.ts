import { describe, expect, test } from 'bun:test'
import { getChatDrawerPath } from './chatDrawerTool'

describe('getChatDrawerPath', () => {
  test('opens the chat drawer on the current path', () => {
    expect(getChatDrawerPath('/settings?section=providers', 'open')).toBe('/settings?section=providers&chat=open')
  })

  test('closes the chat drawer by removing the query param', () => {
    expect(getChatDrawerPath('/settings?section=providers&chat=open', 'closed')).toBe('/settings?section=providers')
  })

  test('toggles open when closed', () => {
    expect(getChatDrawerPath('/settings', 'toggle')).toBe('/settings?chat=open')
  })

  test('toggles closed when open', () => {
    expect(getChatDrawerPath('/settings?chat=expanded', 'toggle')).toBe('/settings')
  })
})
