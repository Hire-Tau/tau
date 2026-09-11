import { fireEvent } from '@testing-library/dom'
import { expect, test } from 'bun:test'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { squadEventRuleSchema, createBlankWorkflow, type SquadEventRule } from '@tau/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { integrationQueries, queries } from '../../queryOptions'
import { SquadEventRulesEditor } from './SquadEventRulesEditor'

test('event rules expose four actions, persist workflow selection, and allow priority and removal edits', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/squads/test/settings' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueries.outputs().queryKey, [
    { integration: 'github', output: 'issue.assigned', version: 1, title: 'Issue assigned', fields: {} },
  ])
  client.setQueryData(integrationQueries.squad('test', 'github').queryKey, { connections: [], attached: [] })
  client.setQueryData(queries.workflows.list().queryKey, [{ id: 'reviewed-coding', definition: createBlankWorkflow() }])
  let value: SquadEventRule[] = []
  function Editor() {
    const [rules, setRules] = useState([
      squadEventRuleSchema.parse({
        id: 'first',
        source: { integration: 'github', output: 'issue.assigned', version: 1 },
        filters: {},
        action: { type: 'notify-manager' },
      }),
    ])
    value = rules
    return <SquadEventRulesEditor squadId="test" provider="github" value={rules} onChange={setRules} disabled={false} />
  }
  const root = dom.createRoot()
  const select = (label: string) =>
    Array.from(document.querySelectorAll('label'))
      .find((element) => element.firstChild?.textContent === label)!
      .querySelector('select')!
  const change = async (element: HTMLSelectElement, next: string) =>
    dom.act(async () => {
      element.value = next
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })
  const click = async (text: string) =>
    dom.act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === text)!
        .click()
    })
  try {
    await dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={client}>
          <Editor />
        </QueryClientProvider>
      )
    )
    expect(Array.from(select('Then').options).map((option) => option.textContent)).toEqual([
      'Notify manager',
      'Notify new consultant',
      'Start work stream',
      'Ignore',
    ])
    await change(select('Then'), 'notify-consultant')
    expect(document.body.textContent).toContain('fresh consultant chat')
    await change(select('Then'), 'start-workstream')
    await change(select('Workflow'), 'reviewed-coding')
    expect(value[0]!.action).toEqual({
      type: 'start-workstream',
      workflow: { kind: 'preset', id: 'reviewed-coding', customizations: [] },
    })
    await change(select('Workflow'), '')
    expect(value[0]!.action).toEqual({ type: 'start-workstream', workflow: undefined })
    await dom.act(async () =>
      fireEvent.input(document.querySelector('textarea')!, {
        target: { value: 'Run the accessibility checks before requesting review.' },
      })
    )
    expect(value[0]!.action).toMatchObject({
      additionalContext: 'Run the accessibility checks before requesting review.',
    })
    await change(select('Workflow'), 'reviewed-coding')
    expect(value[0]!.action).toMatchObject({
      additionalContext: 'Run the accessibility checks before requesting review.',
    })
    expect(document.body.textContent).toContain('shared scope above is ignored')
    await change(select('Account involvement'), 'any')
    expect(document.body.textContent).toContain('Includes events from the account itself and bots')
    await change(select('Account involvement'), 'assigned-or-mentioned')
    expect(document.body.textContent).toContain('Ignore events authored by that account or a bot')
    await click('Add event rule')
    expect(value).toHaveLength(2)
    expect(value[1]!.id).toBe('first')
    await click('Down')
    expect(value[0]!.id).toBe('first')
    await change(select('Then'), 'ignore')
    expect(value[0]!.action.type).toBe('ignore')
    await click('Remove')
    await click('Remove')
    expect(value).toEqual([])
    expect(document.body.textContent).toContain('No squad actions')
  } finally {
    client.clear()
    await dom.cleanup()
  }
})
