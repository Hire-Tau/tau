import { Type } from '@sinclair/typebox'
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'

// --- Types ---

export interface TodoItem {
  text: string
  completed: boolean
  depends: number[] // one-based indices of items this depends on
}

export type TodoToolWithKey = ToolDefinition & { key: string }

// --- Storage interface ---

/**
 * Minimal storage backend for todo tools.
 * Implementations can back this with task artifacts, filesystem, etc.
 */
export interface TodoStorageOps {
  read(): Promise<string | null>
  write(content: string): Promise<void>
}

// --- Markdown parsing/formatting ---

/**
 * Parse markdown todo items. Supports dependency syntax:
 *   - [ ] Item text (depends: 1, 3)
 */
export function parseTodoMarkdown(md: string): TodoItem[] {
  const items: TodoItem[] = []
  for (const line of md.split('\n')) {
    const match = line.match(/^- \[([ xX])\] (.+)$/)
    if (match) {
      let text = match[2]
      let depends: number[] = []
      const depMatch = text.match(/\s*\(depends:\s*([0-9,\s]+)\)\s*$/)
      if (depMatch) {
        depends = depMatch[1]
          .split(',')
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n))
        text = text.slice(0, depMatch.index!).trimEnd()
      }
      items.push({ text, completed: match[1] !== ' ', depends })
    }
  }
  return items
}

export function formatTodoMarkdown(items: TodoItem[]): string {
  return items
    .map((item) => {
      const checkbox = item.completed ? 'x' : ' '
      const depSuffix = item.depends.length > 0 ? ` (depends: ${item.depends.join(', ')})` : ''
      return `- [${checkbox}] ${item.text}${depSuffix}`
    })
    .join('\n')
}

/**
 * Check if an item's dependencies are all completed.
 * Returns list of unmet dependency indices (one-based).
 */
export function getUnmetDependencies(items: TodoItem[], index: number): number[] {
  const item = items[index]
  if (!item || item.depends.length === 0) return []
  return item.depends.filter((dep) => {
    const depIdx = dep - 1
    return depIdx >= 0 && depIdx < items.length && !items[depIdx].completed
  })
}

/**
 * Create a TodoStorageOps backed by a file on disk.
 */
export function createFileTodoStorage(filePath: string): TodoStorageOps {
  return {
    async read() {
      const fs = await import('fs/promises')
      try {
        return await fs.readFile(filePath, 'utf-8')
      } catch {
        return null
      }
    },
    async write(content: string) {
      const fs = await import('fs/promises')
      const path = await import('path')
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, content, 'utf-8')
    },
  }
}

// --- TypeBox Schemas ---

const TodoAddItemSchema = Type.Object({
  text: Type.String({ description: 'Text of the todo item.' }),
  depends: Type.Optional(
    Type.Array(Type.Number(), {
      description: 'One-based indices of items this depends on. Item cannot be completed until dependencies are done.',
    })
  ),
})

const TodoAddSchema = Type.Object({
  items: Type.Array(TodoAddItemSchema, {
    description: 'Items to add to the checklist.',
    minItems: 1,
  }),
})

const TodoToggleSchema = Type.Object({
  index: Type.Number({ description: 'One-based index of the item to toggle.' }),
})

const TodoRemoveSchema = Type.Object({
  index: Type.Number({ description: 'One-based index of the item to remove.' }),
})

const TodoUpdateSchema = Type.Object({
  add: Type.Optional(
    Type.Array(TodoAddItemSchema, {
      description: 'Todo items to append before removals. Same item shape as todo_add.',
      minItems: 1,
    })
  ),
  toggle: Type.Optional(
    Type.Array(Type.Integer(), {
      description:
        'One-based indexes of existing todo items to toggle. Indexes refer to the todo list as it existed at the start of the batch and are applied in the order provided before removals.',
      minItems: 1,
    })
  ),
  remove: Type.Optional(
    Type.Array(Type.Integer(), {
      description:
        'One-based indexes of existing todo items to remove. Indexes refer to the todo list as it existed at the start of the batch; removals are applied from greatest index to least index.',
      minItems: 1,
    })
  ),
})

type TodoUpdateParams = {
  add?: Array<{ text: string; depends?: number[] }>
  toggle?: number[]
  remove?: number[]
}

function toolText(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: 'text' as const, text }], details }
}

function invalidIndexResult(index: number, itemCount: number): AgentToolResult<unknown> {
  return toolText(`Invalid index ${index}. There are ${itemCount} items.`, { error: 'invalid_index' })
}

function isValidOneBasedIndex(index: number, itemCount: number): boolean {
  return Number.isInteger(index) && index >= 1 && index <= itemCount
}

function findDuplicateIndex(indexes: number[]): number | null {
  const seen = new Set<number>()
  for (const index of indexes) {
    if (seen.has(index)) return index
    seen.add(index)
  }
  return null
}

function removeTodoAtOneBasedIndex(items: TodoItem[], index: number): TodoItem {
  const removed = items.splice(index - 1, 1)[0]
  for (const item of items) {
    item.depends = item.depends.filter((d) => d !== index).map((d) => (d > index ? d - 1 : d))
  }
  return removed
}

// --- Factory ---

export function createTodoTools(storage: TodoStorageOps): TodoToolWithKey[] {
  const todoList: TodoToolWithKey = {
    name: 'todo_list',
    key: 'todo_list',
    label: 'List Todos',
    description: 'List all todo items showing completion status and dependencies.',
    parameters: Type.Object({}),
    async execute(_toolCallId: string): Promise<AgentToolResult<unknown>> {
      const content = await storage.read()
      if (!content) {
        return {
          content: [{ type: 'text' as const, text: 'No todos yet. Use todo_add to create items.' }],
          details: { count: 0 },
        }
      }
      const items = parseTodoMarkdown(content)
      const completed = items.filter((i) => i.completed).length
      const blocked = items.filter((i, idx) => !i.completed && getUnmetDependencies(items, idx).length > 0).length
      const header = `${completed}/${items.length} completed${blocked > 0 ? `, ${blocked} blocked` : ''}\n\n`
      return {
        content: [{ type: 'text' as const, text: header + content }],
        details: { count: items.length, completed, blocked },
      }
    },
  }

  const todoAdd: TodoToolWithKey = {
    name: 'todo_add',
    key: 'todo_add',
    label: 'Add Todos',
    description:
      'Add one or more items to the checklist. Each item can optionally depend on other items by their one-based index — the item cannot be completed until its dependencies are done.',
    parameters: TodoAddSchema,
    async execute(
      _toolCallId: string,
      params: { items: Array<{ text: string; depends?: number[] }> }
    ): Promise<AgentToolResult<unknown>> {
      const existing = await storage.read()
      const existingItems = existing ? parseTodoMarkdown(existing) : []

      const newItems: TodoItem[] = params.items.map((item) => ({
        text: item.text,
        completed: false,
        depends: item.depends ?? [],
      }))

      const allItems = [...existingItems, ...newItems]
      await storage.write(formatTodoMarkdown(allItems))

      return {
        content: [{ type: 'text' as const, text: `Added ${params.items.length} item(s) to checklist.` }],
        details: { added: params.items.length },
      }
    },
  }

  const todoToggle: TodoToolWithKey = {
    name: 'todo_toggle',
    key: 'todo_toggle',
    label: 'Toggle Todo',
    description:
      'Toggle the completion status of a todo item by its one-based index. Cannot mark an item complete if it has unmet dependencies.',
    parameters: TodoToggleSchema,
    async execute(_toolCallId: string, params: { index: number }): Promise<AgentToolResult<unknown>> {
      const content = await storage.read()
      if (!content) {
        return {
          content: [{ type: 'text' as const, text: 'No todos exist. Use todo_add first.' }],
          details: { error: 'no_todos' },
        }
      }

      const items = parseTodoMarkdown(content)
      if (!isValidOneBasedIndex(params.index, items.length)) {
        return invalidIndexResult(params.index, items.length)
      }

      const idx = params.index - 1
      if (!items[idx].completed) {
        const unmet = getUnmetDependencies(items, idx)
        if (unmet.length > 0) {
          const unmetTexts = unmet.map((d) => `${d}. ${items[d - 1].text}`).join(', ')
          return {
            content: [
              {
                type: 'text' as const,
                text: `Cannot complete item ${params.index}: blocked by unfinished dependencies: ${unmetTexts}`,
              },
            ],
            details: { error: 'blocked', unmetDependencies: unmet },
          }
        }
      }

      items[idx].completed = !items[idx].completed
      await storage.write(formatTodoMarkdown(items))

      const status = items[idx].completed ? 'completed' : 'uncompleted'
      return {
        content: [{ type: 'text' as const, text: `Item ${params.index} marked as ${status}: "${items[idx].text}"` }],
        details: { index: params.index, completed: items[idx].completed },
      }
    },
  }

  const todoRemove: TodoToolWithKey = {
    name: 'todo_remove',
    key: 'todo_remove',
    label: 'Remove Todo',
    description: 'Remove a todo item by its one-based index.',
    parameters: TodoRemoveSchema,
    async execute(_toolCallId: string, params: { index: number }): Promise<AgentToolResult<unknown>> {
      const content = await storage.read()
      if (!content) {
        return {
          content: [{ type: 'text' as const, text: 'No todos exist. Use todo_add first.' }],
          details: { error: 'no_todos' },
        }
      }

      const items = parseTodoMarkdown(content)
      if (!isValidOneBasedIndex(params.index, items.length)) {
        return invalidIndexResult(params.index, items.length)
      }

      const removed = removeTodoAtOneBasedIndex(items, params.index)

      await storage.write(formatTodoMarkdown(items))

      return {
        content: [{ type: 'text' as const, text: `Removed item ${params.index}: "${removed.text}"` }],
        details: { removed: removed.text },
      }
    },
  }

  const todoUpdate: TodoToolWithKey = {
    name: 'todo_update',
    key: 'todo_update',
    label: 'Update Todos',
    description:
      'Batch update the todo checklist: add items, toggle existing items, and remove existing items in one call. Toggle/remove indexes refer to the todo list as it existed at the start of the batch.',
    parameters: TodoUpdateSchema,
    async execute(_toolCallId: string, params: TodoUpdateParams): Promise<AgentToolResult<unknown>> {
      const addItems = params.add ?? []
      const toggleIndexes = params.toggle ?? []
      const removeIndexes = params.remove ?? []

      if (addItems.length === 0 && toggleIndexes.length === 0 && removeIndexes.length === 0) {
        return toolText('No todo_update operations provided.', { error: 'no_operations' })
      }

      for (const [operation, indexes] of [
        ['toggle', toggleIndexes],
        ['remove', removeIndexes],
      ] as const) {
        const duplicate = findDuplicateIndex(indexes)
        if (duplicate !== null) {
          return toolText(`Duplicate ${operation} index ${duplicate}. Each ${operation} index may appear only once.`, {
            error: 'duplicate_index',
            operation,
            index: duplicate,
          })
        }
      }

      const existing = await storage.read()
      const originalItems = existing ? parseTodoMarkdown(existing) : []
      const originalCount = originalItems.length

      if (originalCount === 0 && (toggleIndexes.length > 0 || removeIndexes.length > 0)) {
        return toolText('No todos exist. Use todo_add first.', { error: 'no_todos' })
      }

      for (const index of [...toggleIndexes, ...removeIndexes]) {
        if (!isValidOneBasedIndex(index, originalCount)) {
          return invalidIndexResult(index, originalCount)
        }
      }

      const items = originalItems.map((item) => ({ ...item, depends: [...item.depends] }))
      const toggledItems: Array<{ index: number; text: string; completed: boolean }> = []

      for (const index of toggleIndexes) {
        const idx = index - 1
        if (!items[idx].completed) {
          const unmet = getUnmetDependencies(items, idx)
          if (unmet.length > 0) {
            const unmetTexts = unmet.map((d) => `${d}. ${items[d - 1].text}`).join(', ')
            return toolText(`Cannot complete item ${index}: blocked by unfinished dependencies: ${unmetTexts}`, {
              error: 'blocked',
              unmetDependencies: unmet,
            })
          }
        }

        items[idx].completed = !items[idx].completed
        toggledItems.push({ index, text: items[idx].text, completed: items[idx].completed })
      }

      const addedItems = addItems.map((item) => ({ text: item.text, completed: false, depends: item.depends ?? [] }))
      items.push(...addedItems)

      const removedItems = [...removeIndexes]
        .sort((a, b) => b - a)
        .map((index) => ({ index, text: removeTodoAtOneBasedIndex(items, index).text }))
        .sort((a, b) => a.index - b.index)

      await storage.write(formatTodoMarkdown(items))

      return toolText(
        `Updated checklist: added ${addedItems.length}, toggled ${toggledItems.length}, removed ${removedItems.length}.`,
        {
          added: addedItems.length,
          toggled: toggledItems.length,
          removed: removedItems.length,
          toggledItems,
          removedItems,
          count: items.length,
        }
      )
    },
  }

  return [todoList, todoAdd, todoToggle, todoRemove, todoUpdate]
}
