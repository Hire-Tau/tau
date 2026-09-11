import { describe, test, expect } from 'bun:test'
import {
  createShortTermMemoryTools,
  formatShortTermMemoryPrompt,
  type ShortTermMemoryStorageOps,
} from './short-term-memory'

// --- Mock storage for testing ---

function createMockStorage(initial: string = ''): ShortTermMemoryStorageOps & { content: string } {
  const storage = {
    content: initial,
    async read() {
      return storage.content
    },
    async write(content: string) {
      storage.content = content
    },
  }
  return storage
}

// --- formatShortTermMemoryPrompt tests ---

describe('formatShortTermMemoryPrompt', () => {
  test('returns empty state message when content is empty', () => {
    const result = formatShortTermMemoryPrompt('')
    expect(result).toContain('## Short-Term Memory')
    expect(result).toContain('Empty')
    expect(result).toContain('0/10000')
    expect(result).toContain('short_term_memory_write')
  })

  test('returns content with character count when populated', () => {
    const result = formatShortTermMemoryPrompt('Hello world')
    expect(result).toContain('## Short-Term Memory')
    expect(result).toContain('11/10000')
    expect(result).toContain('Hello world')
    expect(result).toContain('short_term_memory_write')
    expect(result).toContain('short_term_memory_edit')
  })

  test('shows correct character count for longer content', () => {
    const content = 'a'.repeat(500)
    const result = formatShortTermMemoryPrompt(content)
    expect(result).toContain('500/10000')
  })
})

// --- short_term_memory_read tests ---

describe('short_term_memory_read', () => {
  test('returns empty message when storage is empty', async () => {
    const storage = createMockStorage('')
    const [readTool] = createShortTermMemoryTools(storage)

    const result = await readTool.execute('call-1', {}, undefined, undefined, {} as any)
    expect((result.content[0] as any).text).toBe('(empty)')
    expect(result.details).toEqual({ length: 0 })
  })

  test('returns content when storage has data', async () => {
    const storage = createMockStorage('My notes here')
    const [readTool] = createShortTermMemoryTools(storage)

    const result = await readTool.execute('call-1', {}, undefined, undefined, {} as any)
    expect((result.content[0] as any).text).toBe('My notes here')
    expect(result.details).toEqual({ length: 13 })
  })
})

// --- short_term_memory_write tests ---

describe('short_term_memory_write', () => {
  test('writes content to storage', async () => {
    const storage = createMockStorage('')
    const [, writeTool] = createShortTermMemoryTools(storage)

    const result = await writeTool.execute('call-1', { content: 'New content' }, undefined, undefined, {} as any)
    expect(storage.content).toBe('New content')
    expect((result.content[0] as any).text).toContain('Short-term memory updated')
    expect((result.content[0] as any).text).toContain('11/10000')
    expect((result.content[0] as any).text).toContain('New content')
  })

  test('replaces existing content', async () => {
    const storage = createMockStorage('Old content')
    const [, writeTool] = createShortTermMemoryTools(storage)

    await writeTool.execute('call-1', { content: 'New content' }, undefined, undefined, {} as any)
    expect(storage.content).toBe('New content')
  })

  test('rejects content exceeding max length', async () => {
    const storage = createMockStorage('')
    const [, writeTool] = createShortTermMemoryTools(storage)

    const longContent = 'a'.repeat(10001)
    const result = await writeTool.execute('call-1', { content: longContent }, undefined, undefined, {} as any)

    expect((result.content[0] as any).text).toContain('exceeds maximum length')
    expect((result.content[0] as any).text).toContain('10001')
    expect(result.details).toEqual({ error: 'too_long', length: 10001, maxLength: 10000 })
    expect(storage.content).toBe('') // unchanged
  })

  test('allows content at exactly max length', async () => {
    const storage = createMockStorage('')
    const [, writeTool] = createShortTermMemoryTools(storage)

    const maxContent = 'a'.repeat(10000)
    const result = await writeTool.execute('call-1', { content: maxContent }, undefined, undefined, {} as any)

    expect(storage.content).toBe(maxContent)
    expect((result.content[0] as any).text).toContain('10000/10000')
  })

  test('allows empty content to clear memory', async () => {
    const storage = createMockStorage('Some content')
    const [, writeTool] = createShortTermMemoryTools(storage)

    const result = await writeTool.execute('call-1', { content: '' }, undefined, undefined, {} as any)
    expect(storage.content).toBe('')
    expect((result.content[0] as any).text).toContain('0/10000')
  })
})

// --- short_term_memory_edit tests ---

describe('short_term_memory_edit', () => {
  test('replaces exact match with new text', async () => {
    const storage = createMockStorage('Hello world')
    const [, , editTool] = createShortTermMemoryTools(storage)

    const result = await editTool.execute(
      'call-1',
      { oldText: 'world', newText: 'there' },
      undefined,
      undefined,
      {} as any
    )
    expect(storage.content).toBe('Hello there')
    expect((result.content[0] as any).text).toContain('Short-term memory updated')
    expect((result.content[0] as any).text).toContain('Hello there')
  })

  test('rejects empty oldText', async () => {
    const storage = createMockStorage('Hello world')
    const [, , editTool] = createShortTermMemoryTools(storage)

    const result = await editTool.execute('call-1', { oldText: '', newText: 'new' }, undefined, undefined, {} as any)
    expect((result.content[0] as any).text).toContain('oldText cannot be empty')
    expect(result.details).toEqual({ error: 'empty_old_text' })
    expect(storage.content).toBe('Hello world') // unchanged
  })

  test('rejects edit when memory is empty', async () => {
    const storage = createMockStorage('')
    const [, , editTool] = createShortTermMemoryTools(storage)

    const result = await editTool.execute('call-1', { oldText: 'foo', newText: 'bar' }, undefined, undefined, {} as any)
    expect((result.content[0] as any).text).toContain('Short-term memory is empty')
    expect(result.details).toEqual({ error: 'empty_memory' })
  })

  test('rejects edit when oldText not found', async () => {
    const storage = createMockStorage('Hello world')
    const [, , editTool] = createShortTermMemoryTools(storage)

    const result = await editTool.execute('call-1', { oldText: 'foo', newText: 'bar' }, undefined, undefined, {} as any)
    expect((result.content[0] as any).text).toContain('Could not find exact match')
    expect((result.content[0] as any).text).toContain('foo') // shows what was searched
    expect((result.content[0] as any).text).toContain('Hello world') // shows current content
    expect(result.details).toEqual({ error: 'no_match' })
    expect(storage.content).toBe('Hello world') // unchanged
  })

  test('rejects edit when multiple matches found', async () => {
    const storage = createMockStorage('foo bar foo baz')
    const [, , editTool] = createShortTermMemoryTools(storage)

    const result = await editTool.execute('call-1', { oldText: 'foo', newText: 'qux' }, undefined, undefined, {} as any)
    expect((result.content[0] as any).text).toContain('2 occurrences')
    expect((result.content[0] as any).text).toContain('more specific match')
    expect(result.details).toEqual({ error: 'multiple_matches', occurrences: 2 })
    expect(storage.content).toBe('foo bar foo baz') // unchanged
  })

  test('allows deletion with empty newText', async () => {
    const storage = createMockStorage('Hello world')
    const [, , editTool] = createShortTermMemoryTools(storage)

    const result = await editTool.execute('call-1', { oldText: ' world', newText: '' }, undefined, undefined, {} as any)
    expect(storage.content).toBe('Hello')
    expect((result.content[0] as any).text).toContain('5/10000')
  })

  test('rejects edit that would exceed max length', async () => {
    const storage = createMockStorage('x' + 'a'.repeat(9998))
    const [, , editTool] = createShortTermMemoryTools(storage)

    // Try to replace 'x' with 'xxx' (would be 10001 total)
    const result = await editTool.execute('call-1', { oldText: 'x', newText: 'xxx' }, undefined, undefined, {} as any)
    expect((result.content[0] as any).text).toContain('exceed maximum length')
    expect((result.content[0] as any).text).toContain('10001')
    expect(result.details).toEqual({ error: 'too_long', resultLength: 10001, maxLength: 10000 })
    expect(storage.content).toBe('x' + 'a'.repeat(9998)) // unchanged
  })

  test('handles whitespace-sensitive matching', async () => {
    const storage = createMockStorage('line1\nline2\nline3')
    const [, , editTool] = createShortTermMemoryTools(storage)

    // Replace including newline
    await editTool.execute('call-1', { oldText: '\nline2\n', newText: '\nupdated\n' }, undefined, undefined, {} as any)
    expect(storage.content).toBe('line1\nupdated\nline3')
  })
})

// --- Tool metadata tests ---

describe('tool metadata', () => {
  test('tools have correct names and keys', () => {
    const storage = createMockStorage()
    const tools = createShortTermMemoryTools(storage)

    expect(tools[0].name).toBe('short_term_memory_read')
    expect(tools[0].key).toBe('short_term_memory_read')

    expect(tools[1].name).toBe('short_term_memory_write')
    expect(tools[1].key).toBe('short_term_memory_write')

    expect(tools[2].name).toBe('short_term_memory_edit')
    expect(tools[2].key).toBe('short_term_memory_edit')
  })

  test('tools have descriptions', () => {
    const storage = createMockStorage()
    const tools = createShortTermMemoryTools(storage)

    tools.forEach((tool) => {
      expect(tool.description).toBeTruthy()
      expect(tool.description!.length).toBeGreaterThan(10)
    })
  })
})
