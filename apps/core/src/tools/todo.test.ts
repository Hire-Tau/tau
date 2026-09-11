import { describe, test, expect } from 'bun:test'
import {
  parseTodoMarkdown,
  formatTodoMarkdown,
  getUnmetDependencies,
  createTodoTools,
  type TodoItem,
  type TodoStorageOps,
} from './todo'

function createMockStorage(initial: string | null = null): TodoStorageOps & { content: string | null } {
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

function getTodoUpdateTool(storage: TodoStorageOps) {
  const tool = createTodoTools(storage).find((t) => t.name === 'todo_update')
  if (!tool) throw new Error('todo_update tool not found')
  return tool
}

describe('todo markdown parsing', () => {
  test('parses empty string', () => {
    expect(parseTodoMarkdown('')).toEqual([])
  })

  test('parses unchecked items', () => {
    const md = '- [ ] First item\n- [ ] Second item'
    const items = parseTodoMarkdown(md)
    expect(items).toEqual([
      { text: 'First item', completed: false, depends: [] },
      { text: 'Second item', completed: false, depends: [] },
    ])
  })

  test('parses checked items', () => {
    const md = '- [x] Done item\n- [X] Also done'
    const items = parseTodoMarkdown(md)
    expect(items).toEqual([
      { text: 'Done item', completed: true, depends: [] },
      { text: 'Also done', completed: true, depends: [] },
    ])
  })

  test('parses mixed items', () => {
    const md = '- [x] Done\n- [ ] Not done\n- [x] Also done'
    const items = parseTodoMarkdown(md)
    expect(items.length).toBe(3)
    expect(items[0].completed).toBe(true)
    expect(items[1].completed).toBe(false)
    expect(items[2].completed).toBe(true)
  })

  test('ignores non-todo lines', () => {
    const md = '# My Todos\n\n- [ ] Item 1\nSome text\n- [x] Item 2'
    const items = parseTodoMarkdown(md)
    expect(items.length).toBe(2)
  })

  test('parses items with dependencies', () => {
    const md = '- [ ] First item\n- [ ] Second item (depends: 1)\n- [ ] Third item (depends: 1, 2)'
    const items = parseTodoMarkdown(md)
    expect(items).toEqual([
      { text: 'First item', completed: false, depends: [] },
      { text: 'Second item', completed: false, depends: [1] },
      { text: 'Third item', completed: false, depends: [1, 2] },
    ])
  })

  test('strips dependency suffix from text', () => {
    const md = '- [ ] Deploy app (depends: 1, 3)'
    const items = parseTodoMarkdown(md)
    expect(items[0].text).toBe('Deploy app')
    expect(items[0].depends).toEqual([1, 3])
  })
})

describe('todo markdown formatting', () => {
  test('formats empty list', () => {
    expect(formatTodoMarkdown([])).toBe('')
  })

  test('formats items with checkboxes', () => {
    const items: TodoItem[] = [
      { text: 'First', completed: false, depends: [] },
      { text: 'Second', completed: true, depends: [] },
    ]
    expect(formatTodoMarkdown(items)).toBe('- [ ] First\n- [x] Second')
  })

  test('formats items with dependencies', () => {
    const items: TodoItem[] = [
      { text: 'First', completed: false, depends: [] },
      { text: 'Second', completed: false, depends: [1] },
      { text: 'Third', completed: false, depends: [1, 2] },
    ]
    expect(formatTodoMarkdown(items)).toBe('- [ ] First\n- [ ] Second (depends: 1)\n- [ ] Third (depends: 1, 2)')
  })

  test('roundtrips through parse and format', () => {
    const md = '- [ ] First\n- [ ] Second (depends: 1)\n- [x] Third (depends: 1, 2)'
    expect(formatTodoMarkdown(parseTodoMarkdown(md))).toBe(md)
  })
})

describe('getUnmetDependencies', () => {
  test('returns empty for item with no dependencies', () => {
    const items: TodoItem[] = [{ text: 'A', completed: false, depends: [] }]
    expect(getUnmetDependencies(items, 0)).toEqual([])
  })

  test('returns unmet dependencies', () => {
    const items: TodoItem[] = [
      { text: 'A', completed: false, depends: [] },
      { text: 'B', completed: false, depends: [] },
      { text: 'C', completed: false, depends: [1, 2] },
    ]
    expect(getUnmetDependencies(items, 2)).toEqual([1, 2])
  })

  test('returns only unmet dependencies', () => {
    const items: TodoItem[] = [
      { text: 'A', completed: true, depends: [] },
      { text: 'B', completed: false, depends: [] },
      { text: 'C', completed: false, depends: [1, 2] },
    ]
    expect(getUnmetDependencies(items, 2)).toEqual([2])
  })

  test('returns empty when all dependencies met', () => {
    const items: TodoItem[] = [
      { text: 'A', completed: true, depends: [] },
      { text: 'B', completed: true, depends: [] },
      { text: 'C', completed: false, depends: [1, 2] },
    ]
    expect(getUnmetDependencies(items, 2)).toEqual([])
  })
})

describe('todo_update', () => {
  test('registers todo_update with name, key, description, and schema', () => {
    const tools = createTodoTools(createMockStorage())
    const names = tools.map((tool) => tool.name)

    expect(names).toEqual(['todo_list', 'todo_add', 'todo_toggle', 'todo_remove', 'todo_update'])

    const updateTool = tools.find((tool) => tool.name === 'todo_update')!
    expect(updateTool.key).toBe('todo_update')
    expect(updateTool.description).toContain('batch')
    expect(updateTool.description).toContain('start of the batch')
    expect((updateTool.parameters as any).properties.add).toBeTruthy()
    expect((updateTool.parameters as any).properties.toggle).toBeTruthy()
    expect((updateTool.parameters as any).properties.remove).toBeTruthy()
  })

  test('adds multiple items in one update', async () => {
    const storage = createMockStorage('- [ ] Existing')
    const updateTool = getTodoUpdateTool(storage)

    const result = await updateTool.execute(
      'call-1',
      { add: [{ text: 'Second' }, { text: 'Third', depends: [1] }] },
      undefined,
      undefined,
      {} as any
    )

    expect(storage.content).toBe('- [ ] Existing\n- [ ] Second\n- [ ] Third (depends: 1)')
    expect(result.details).toMatchObject({ added: 2, toggled: 0, removed: 0 })
  })

  test('toggles multiple existing items in one update', async () => {
    const storage = createMockStorage('- [ ] First\n- [ ] Second')
    const updateTool = getTodoUpdateTool(storage)

    const result = await updateTool.execute('call-1', { toggle: [1, 2] }, undefined, undefined, {} as any)

    expect(storage.content).toBe('- [x] First\n- [x] Second')
    expect(result.details).toMatchObject({ added: 0, toggled: 2, removed: 0 })
  })

  test('removes multiple existing items using start indexes and descending removal order', async () => {
    const storage = createMockStorage('- [ ] A\n- [ ] B\n- [ ] C\n- [ ] D\n- [ ] E')
    const updateTool = getTodoUpdateTool(storage)

    const result = await updateTool.execute('call-1', { remove: [2, 4] }, undefined, undefined, {} as any)

    expect(storage.content).toBe('- [ ] A\n- [ ] C\n- [ ] E')
    expect(result.details).toMatchObject({ added: 0, toggled: 0, removed: 2 })
  })

  test('applies toggles and adds before removals with toggle/remove indexes based on the start list', async () => {
    const storage = createMockStorage('- [ ] A\n- [ ] B\n- [ ] C\n- [ ] D')
    const updateTool = getTodoUpdateTool(storage)

    const result = await updateTool.execute(
      'call-1',
      { toggle: [4], add: [{ text: 'E' }], remove: [2] },
      undefined,
      undefined,
      {} as any
    )

    expect(storage.content).toBe('- [ ] A\n- [ ] C\n- [x] D\n- [ ] E')
    expect(result.details).toMatchObject({ added: 1, toggled: 1, removed: 1 })
  })

  test('does not write any changes when a requested toggle is blocked by unmet dependencies', async () => {
    const storage = createMockStorage('- [ ] First\n- [ ] Second (depends: 1)')
    const updateTool = getTodoUpdateTool(storage)

    const result = await updateTool.execute(
      'call-1',
      { toggle: [2], add: [{ text: 'Third' }] },
      undefined,
      undefined,
      {} as any
    )

    expect((result.content[0] as any).text).toContain('Cannot complete item 2')
    expect(result.details).toEqual({ error: 'blocked', unmetDependencies: [1] })
    expect(storage.content).toBe('- [ ] First\n- [ ] Second (depends: 1)')
  })

  test('rejects empty update batches', async () => {
    const storage = createMockStorage('- [ ] First')
    const updateTool = getTodoUpdateTool(storage)

    const result = await updateTool.execute('call-1', {}, undefined, undefined, {} as any)

    expect(result.details).toEqual({ error: 'no_operations' })
    expect(storage.content).toBe('- [ ] First')
  })

  test('rejects duplicate indexes within one remove batch', async () => {
    const storage = createMockStorage('- [ ] A\n- [ ] B\n- [ ] C')
    const updateTool = getTodoUpdateTool(storage)

    const result = await updateTool.execute('call-1', { remove: [2, 2] }, undefined, undefined, {} as any)

    expect(result.details).toEqual({ error: 'duplicate_index', operation: 'remove', index: 2 })
    expect(storage.content).toBe('- [ ] A\n- [ ] B\n- [ ] C')
  })

  test('rejects fractional indexes without writing', async () => {
    const storage = createMockStorage('- [ ] A\n- [ ] B\n- [ ] C')
    const updateTool = getTodoUpdateTool(storage)

    const result = await updateTool.execute('call-1', { toggle: [1.5] }, undefined, undefined, {} as any)

    expect(result.details).toEqual({ error: 'invalid_index' })
    expect(storage.content).toBe('- [ ] A\n- [ ] B\n- [ ] C')
  })
})

describe('todo_remove', () => {
  test('still removes one item and adjusts dependency indexes', async () => {
    const storage = createMockStorage('- [ ] A\n- [ ] B\n- [ ] C (depends: 1, 2)')
    const removeTool = createTodoTools(storage).find((tool) => tool.name === 'todo_remove')!

    const result = await removeTool.execute('call-1', { index: 2 }, undefined, undefined, {} as any)

    expect(storage.content).toBe('- [ ] A\n- [ ] C (depends: 1)')
    expect((result.content[0] as any).text).toContain('Removed item 2')
  })
})
