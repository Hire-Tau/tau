import { useState } from 'react'
import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import { SharedPromptPicker } from './SharedPromptPicker'

const catalog = [
  { id: 'rules', name: 'Rules', disabled: false },
  { id: 'squad-rules', name: 'Squad rules', disabled: false },
  { id: 'subagents', name: 'Subagents', disabled: false },
]

/**
 * The picker is controlled, so the assertions below need a real owner of the
 * list: these tests check that a click produces the right *next* list, which a
 * static render cannot show.
 */
function Harness({ initial }: { initial: string[] }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <SharedPromptPicker value={value} onChange={setValue} />
      <p data-testid="value">{value.join('|')}</p>
    </>
  )
}

describe('SharedPromptPicker interactions', () => {
  let cleanup: (() => Promise<void>) | undefined
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>

  afterEach(async () => {
    await cleanup?.()
    cleanup = undefined
  })

  async function render(initial: string[]) {
    dom = await acquireDomHarness({ url: 'http://localhost/settings' })
    const rendered = dom.createRoot()
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    queryClient.setQueryData(queryKeys.sharedPrompts.list(), catalog)
    cleanup = async () => {
      await dom.cleanup()
      queryClient.clear()
    }
    await dom.act(async () => {
      rendered.root.render(
        <QueryClientProvider client={queryClient}>
          <Harness initial={initial} />
        </QueryClientProvider>
      )
    })
    return dom.window.document.body
  }

  const listed = (body: Element) => body.querySelector('[data-testid="value"]')!.textContent

  test('choosing from the select appends the shared prompt to the end of the list', async () => {
    const body = await render(['rules'])
    const select = body.querySelector('select')!
    await dom.act(async () => {
      fireEvent.change(select, { target: { value: 'subagents' } })
    })
    expect(listed(body)).toBe('rules|subagents')
  })

  test('the down arrow swaps a prompt with the one after it', async () => {
    const body = await render(['rules', 'squad-rules'])
    await dom.act(async () => {
      fireEvent.click(body.querySelector('[aria-label="Move rules down"]')!)
    })
    expect(listed(body)).toBe('squad-rules|rules')
  })

  test('removing a duplicated id drops only the row that was clicked', async () => {
    // Order is meaningful and a stored list may repeat an id, so removal has to
    // go by position — removing by value would wipe both copies.
    const body = await render(['rules', 'squad-rules', 'rules'])
    const removeButtons = [...body.querySelectorAll('[aria-label="Remove rules"]')]
    expect(removeButtons).toHaveLength(2)
    await dom.act(async () => {
      fireEvent.click(removeButtons[1]!)
    })
    expect(listed(body)).toBe('rules|squad-rules')
  })
})
