import { describe, test, expect } from 'bun:test'
import { chunkByLines, isBinaryContent } from './parser'

describe('chunkByLines', () => {
  test('chunks a small file into a single chunk', () => {
    const content = 'line 1\nline 2\nline 3'
    const chunks = chunkByLines(content)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe(content)
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[0].endLine).toBe(3)
    expect(chunks[0].index).toBe(0)
  })

  test('splits on blank lines when possible', () => {
    const block1 = Array.from({ length: 50 }, (_, i) => `block1 line ${i + 1}`).join('\n')
    const block2 = Array.from({ length: 50 }, (_, i) => `block2 line ${i + 1}`).join('\n')
    const content = block1 + '\n\n' + block2
    const chunks = chunkByLines(content, { maxLines: 60 })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0].content).toContain('block1')
    expect(chunks[1].content).toContain('block2')
  })

  test('hard-splits at maxLines when no blank line found', () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
    const chunks = chunkByLines(content, { maxLines: 80 })
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    for (const chunk of chunks) {
      const lineCount = chunk.content.split('\n').length
      expect(lineCount).toBeLessThanOrEqual(80)
    }
  })

  test('returns empty array for empty content', () => {
    expect(chunkByLines('')).toEqual([])
    expect(chunkByLines('   \n  ')).toEqual([])
  })

  test('preserves correct line numbers', () => {
    const content = Array.from({ length: 160 }, (_, i) => `line ${i + 1}`).join('\n')
    const chunks = chunkByLines(content, { maxLines: 80 })
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[0].endLine).toBe(80)
    expect(chunks[1].startLine).toBe(81)
  })

  test('chunk metadata has no heading info', () => {
    const content = 'line 1\nline 2'
    const chunks = chunkByLines(content)
    expect(chunks[0].metadata).toEqual({})
  })
})

describe('isBinaryContent', () => {
  test('detects null bytes as binary', () => {
    const buf = Buffer.from('hello\x00world')
    expect(isBinaryContent(buf)).toBe(true)
  })

  test('treats normal text as non-binary', () => {
    const buf = Buffer.from('hello world\nline 2')
    expect(isBinaryContent(buf)).toBe(false)
  })

  test('treats empty buffer as non-binary', () => {
    expect(isBinaryContent(Buffer.alloc(0))).toBe(false)
  })
})
