import { acquireDomHarness } from '../../test/domHarness'
import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import type { Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { SquadAgentContextEditor } from './SquadAgentContextEditor'

let domHarness: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

type EditorProps = Parameters<typeof SquadAgentContextEditor>[0]

function renderEditor(props: EditorProps) {
  const queryClient = new QueryClient()
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SquadAgentContextEditor {...props} />
    </QueryClientProvider>
  )
}

async function installDom() {
  return (domHarness = await acquireDomHarness({ url: 'http://localhost/squads/s1/settings' }))
}

async function renderInteractiveEditor(
  props: EditorProps,
  window?: Awaited<ReturnType<typeof acquireDomHarness>>['window']
) {
  if (!window) window = (await installDom()).window
  const queryClient = new QueryClient()
  const { root, container: element } = domHarness!.createRoot()

  await domHarness!.act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SquadAgentContextEditor {...props} />
      </QueryClientProvider>
    )
  })

  return { window, root, queryClient }
}

async function rerenderInteractiveEditor(root: Root, queryClient: QueryClient, props: EditorProps) {
  await domHarness!.act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SquadAgentContextEditor {...props} />
      </QueryClientProvider>
    )
  })
}

async function typeTextareaValue(
  window: Awaited<ReturnType<typeof acquireDomHarness>>['window'],
  textarea: HTMLTextAreaElement,
  value: string
) {
  await domHarness!.act(async () => {
    fireEvent.input(textarea, { target: { value } })
    fireEvent.change(textarea, { target: { value } })
  })
}

async function selectOption(
  window: Awaited<ReturnType<typeof acquireDomHarness>>['window'],
  select: HTMLSelectElement,
  value: string
) {
  await domHarness!.act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
    valueSetter?.call(select, value)
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
}

const ALL_TYPES = [
  { id: 'architect', name: 'Architect' },
  { id: 'engineer', name: 'Engineer' },
  { id: 'manager', name: 'Manager', systemOnly: true },
  { id: 'reviewer', name: 'Reviewer' },
]

const NON_WORKER_TYPES = [
  { id: 'concierge', name: 'Concierge', systemOnly: true },
  { id: 'system-manager', name: 'System Manager', systemOnly: true },
  { id: 'artifact-builder-default', name: 'Artifact Builder Default', systemOnly: true },
]

describe('SquadAgentContextEditor', () => {
  test('only renders fields for types that have context set', () => {
    const html = renderEditor({
      squadId: 's1',
      typeContext: { architect: 'design-first' },
      agentTypes: ALL_TYPES,
    })
    // Architect field should be present with its value
    expect(html).toContain('Architect')
    expect(html).toContain('design-first')
    // Other types should NOT have textarea fields — only the architect field is rendered.
    // Unset types appear only as options in the picker dropdown.
    expect(html).not.toContain('Instructions for Engineer agents')
    expect(html).not.toContain('Instructions for Manager agents')
    expect(html).not.toContain('Instructions for Reviewer agents')
  })

  test('shows the type picker with remaining unset types', () => {
    const html = renderEditor({
      squadId: 's1',
      typeContext: { architect: 'design-first' },
      agentTypes: ALL_TYPES,
    })
    // Picker should contain the unset types as options
    expect(html).toContain('+ Add agent type...')
    expect(html).toContain('Engineer')
    expect(html).toContain('Manager')
    expect(html).toContain('Reviewer')
  })

  test('renders empty state with picker when typeContext is null', () => {
    const html = renderEditor({
      squadId: 's1',
      typeContext: null,
      agentTypes: [{ id: 'general', name: 'General' }],
    })
    expect(html).toContain('Type-Specific Context')
    expect(html).toContain('+ Add agent type...')
    expect(html).toContain('General')
    // No textarea rendered since no context is set
    expect(html).not.toContain('Instructions for General agents')
  })

  test('hides picker when all types have context', () => {
    const html = renderEditor({
      squadId: 's1',
      typeContext: { architect: 'a', engineer: 'b' },
      agentTypes: [
        { id: 'architect', name: 'Architect' },
        { id: 'engineer', name: 'Engineer' },
      ],
    })
    expect(html).not.toContain('+ Add agent type...')
  })

  test('shows message when no agent types available', () => {
    const html = renderEditor({
      squadId: 's1',
      typeContext: null,
      agentTypes: [],
    })
    expect(html).toContain('No agent types available')
  })

  test('renders remove button for each active field', () => {
    const html = renderEditor({
      squadId: 's1',
      typeContext: { architect: 'a', engineer: 'b' },
      agentTypes: ALL_TYPES,
    })
    // Two remove buttons (aria-labels)
    expect(html).toContain('Remove Architect context field')
    expect(html).toContain('Remove Engineer context field')
  })

  test('excludes system-only types from the picker', () => {
    const html = renderEditor({
      squadId: 's1',
      typeContext: null,
      agentTypes: [...ALL_TYPES, ...NON_WORKER_TYPES],
    })
    // Squad-worker types should still be selectable in the picker
    expect(html).toContain('Architect')
    expect(html).toContain('Engineer')
    expect(html).toContain('Reviewer')
    // Non-worker types must NOT appear as picker options
    expect(html).not.toContain('Concierge')
    expect(html).not.toContain('System Manager')
    expect(html).not.toContain('Artifact Builder Default')
  })

  test('hides the picker entirely when only non-worker types remain unset', () => {
    const html = renderEditor({
      squadId: 's1',
      typeContext: null,
      agentTypes: NON_WORKER_TYPES,
    })
    // Only non-worker types available — picker should be absent since no
    // selectable types remain.
    expect(html).not.toContain('+ Add agent type...')
  })

  test('does not exclude a non-worker type that already has context set', () => {
    const html = renderEditor({
      squadId: 's1',
      typeContext: { concierge: 'be-helpful' },
      agentTypes: [...ALL_TYPES, ...NON_WORKER_TYPES],
    })
    // Existing concierge context field must still render and be editable.
    expect(html).toContain('Concierge')
    expect(html).toContain('be-helpful')
    expect(html).toContain('Instructions for Concierge agents')
    // But concierge must NOT appear as a selectable picker option.
    // (Concierge appears only as the field label, never as an <option>.)
    expect(html).not.toContain('System Manager')
    expect(html).not.toContain('Artifact Builder Default')
  })

  test('syncs a saved type context change when there are no local edits', async () => {
    const { window, root, queryClient } = await renderInteractiveEditor({
      squadId: 's1',
      typeContext: { engineer: 'old instructions' },
      agentTypes: ALL_TYPES,
    })

    await rerenderInteractiveEditor(root, queryClient, {
      squadId: 's1',
      typeContext: { engineer: 'new instructions' },
      agentTypes: ALL_TYPES.map((type) => ({ ...type })),
    })

    expect((window.document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('new instructions')

    await domHarness!.act(async () => {
      root.unmount()
    })
  })

  test('preserves an unsaved removal when refreshed props contain the same saved type context', async () => {
    const { window, root, queryClient } = await renderInteractiveEditor({
      squadId: 's1',
      typeContext: { engineer: 'saved instructions' },
      agentTypes: ALL_TYPES,
    })

    const removeButton = window.document.querySelector(
      'button[aria-label="Remove Engineer context field"]'
    ) as HTMLButtonElement
    await domHarness!.act(async () => {
      removeButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })

    expect(window.document.querySelector('textarea')).toBeNull()
    expect(window.document.body.textContent).toContain('Unsaved changes')

    await rerenderInteractiveEditor(root, queryClient, {
      squadId: 's1',
      typeContext: { engineer: 'saved instructions' },
      agentTypes: ALL_TYPES.map((type) => ({ ...type })),
    })

    expect(window.document.querySelector('textarea')).toBeNull()
    expect(window.document.body.textContent).not.toContain('Instructions for Engineer agents')
    expect(window.document.body.textContent).toContain('Unsaved changes')

    await domHarness!.act(async () => {
      root.unmount()
    })
  })

  test('preserves an unsaved edit when refreshed props contain the same saved type context', async () => {
    const { window, root, queryClient } = await renderInteractiveEditor({
      squadId: 's1',
      typeContext: { engineer: 'saved instructions' },
      agentTypes: ALL_TYPES,
    })

    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    await typeTextareaValue(window, textarea, 'draft instructions')

    expect(textarea.value).toBe('draft instructions')

    await rerenderInteractiveEditor(root, queryClient, {
      squadId: 's1',
      typeContext: { engineer: 'saved instructions' },
      agentTypes: ALL_TYPES.map((type) => ({ ...type })),
    })

    expect((window.document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('draft instructions')
    expect(window.document.body.textContent).toContain('Unsaved changes')

    await domHarness!.act(async () => {
      root.unmount()
    })
  })

  test('preserves a newly added unsaved type when refreshed props still have no saved type context', async () => {
    const { window, root, queryClient } = await renderInteractiveEditor({
      squadId: 's1',
      typeContext: null,
      agentTypes: ALL_TYPES,
    })

    const select = window.document.querySelector('select') as HTMLSelectElement
    await selectOption(window, select, 'reviewer')

    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    await typeTextareaValue(window, textarea, 'review carefully')

    expect(textarea.value).toBe('review carefully')

    await rerenderInteractiveEditor(root, queryClient, {
      squadId: 's1',
      typeContext: null,
      agentTypes: ALL_TYPES.map((type) => ({ ...type })),
    })

    expect(window.document.body.textContent).toContain('Reviewer')
    expect((window.document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('review carefully')
    expect(window.document.body.textContent).toContain('Unsaved changes')

    await domHarness!.act(async () => {
      root.unmount()
    })
  })
})

afterEach(async () => {
  await domHarness?.cleanup()
  domHarness = undefined
})
