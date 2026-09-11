import { describe, expect, test } from 'bun:test'
import { MessageRequestGenerations } from './messageRequestGenerations'

describe('MessageRequestGenerations', () => {
  test('cleans settled entries without reusing generations or letting stale cleanup delete a successor', () => {
    const generations = new MessageRequestGenerations()
    const first = generations.begin('message-1')
    expect(generations.size).toBe(1)
    generations.finish('message-1', first)
    expect(generations.size).toBe(0)

    const second = generations.begin('message-1')
    expect(second).toBeGreaterThan(first)
    generations.finish('message-1', first)
    expect(generations.isCurrent('message-1', second)).toBe(true)
    generations.finish('message-1', second)
    expect(generations.size).toBe(0)
  })
})
