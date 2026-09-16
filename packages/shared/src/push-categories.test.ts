import { describe, expect, test } from 'bun:test'
import { PUSH_CATEGORIES, PUSH_CATEGORY_IDS, isPushCategory } from './push-categories'

describe('push categories', () => {
  test('lists the six mutable categories once each, with a label and description', () => {
    expect(PUSH_CATEGORY_IDS).toEqual(['question', 'review', 'done', 'assistant', 'fleet', 'message'])
    expect(new Set(PUSH_CATEGORY_IDS).size).toBe(PUSH_CATEGORIES.length)
    for (const category of PUSH_CATEGORIES) {
      expect(category.label.length).toBeGreaterThan(3)
      expect(category.description.length).toBeGreaterThan(10)
    }
  })

  test('isPushCategory accepts only known ids', () => {
    expect(isPushCategory('done')).toBe(true)
    expect(isPushCategory('inbox.messageReceived')).toBe(false)
    expect(isPushCategory(undefined)).toBe(false)
  })
})
