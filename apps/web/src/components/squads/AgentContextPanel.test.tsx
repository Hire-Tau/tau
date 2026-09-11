import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../../queryKeys'

const { AgentContextPanel } = await import('./AgentContextPanel')

function renderPanel(context: {
  shortTermMemory: string
  todos: { text: string; completed: boolean; depends: number[] }[]
}) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.agents.context('agent-1'), context)

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AgentContextPanel agentId="agent-1" />
    </QueryClientProvider>
  )
}

describe('AgentContextPanel todos', () => {
  test('renders active todo items from agent context', () => {
    const html = renderPanel({
      shortTermMemory: '',
      todos: [
        { text: 'Investigate todo storage', completed: false, depends: [] },
        { text: 'Write focused tests', completed: false, depends: [1] },
      ],
    })

    expect(html).toContain('Todos <span')
    expect(html).toContain('(2)')
    expect(html).toContain('1. Investigate todo storage')
    expect(html).toContain('2. Write focused tests')
    expect(html).toContain('(depends: 1)')
    expect(html).not.toContain('No active todos')
  })

  test('renders empty state when agent context has no todos', () => {
    const html = renderPanel({ shortTermMemory: '', todos: [] })

    expect(html).toContain('No active todos')
    expect(html).not.toContain('(1)')
  })
})
