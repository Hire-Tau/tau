import { acquireDomHarness } from '../test/domHarness'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentViewTabs, type AgentViewTabItem } from './AgentViewTabs'

let domHarness: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

function TestIcon({ className }: { className?: string }) {
  return <svg className={className} aria-hidden="true" />
}

const tabs: AgentViewTabItem<'chat' | 'inbox' | 'context'>[] = [
  { value: 'chat', label: 'Chat', icon: TestIcon },
  { value: 'inbox', label: 'Inbox', icon: TestIcon },
  { value: 'context', label: 'Context', icon: TestIcon, secondary: true },
]

async function installDom() {
  return (domHarness = await acquireDomHarness({ url: 'http://localhost/chat' }))
}

describe('AgentViewTabs', () => {
  test('renders tab buttons with active styling for large screens', () => {
    const html = renderToStaticMarkup(<AgentViewTabs activeTab="inbox" onChange={mock()} tabs={tabs} />)

    expect(html).toContain('Chat')
    expect(html).toContain('Inbox')
    expect(html).toContain('Context')
    expect(html).toContain('bg-accent text-white')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('border-l border-th-border')
    expect(html).toContain('hidden lg:flex')
  })

  test('renders a compact mobile select with a visible themed dropdown arrow', () => {
    const html = renderToStaticMarkup(<AgentViewTabs activeTab="context" onChange={mock()} tabs={tabs} />)

    expect(html).toContain('aria-label="Agent view"')
    expect(html).toContain('lg:hidden')
    expect(html).toContain('<select')
    expect(html).toContain('appearance-none')
    expect(html).toContain('pr-7')
    expect(html).toContain('pointer-events-none')
    expect(html).toContain('text-muted')
    expect(html).toContain('<option value="context" selected="">Context</option>')
  })

  test('shows an accessible active-count badge and progress activity dot', () => {
    const html = renderToStaticMarkup(
      <AgentViewTabs
        activeTab="chat"
        onChange={mock()}
        tabs={[{ value: 'subagents', label: 'Subagents', icon: TestIcon, activeCount: 2 }]}
      />
    )

    expect(html).toContain('Subagents')
    expect(html).toContain('>2</span>')
    expect(html).toContain('bg-blue-500')
    expect(html).toContain('text-blue-700')
    expect(html).toContain('animate-pulse')
    expect(html).toContain('aria-label="Subagents, 2 active subagents"')
    expect(html).toContain('Subagents (2 active)')
  })

  test('hides the active-count badge and dot when no subagents are active', () => {
    const html = renderToStaticMarkup(
      <AgentViewTabs
        activeTab="chat"
        onChange={mock()}
        tabs={[{ value: 'subagents', label: 'Subagents', icon: TestIcon, activeCount: 0 }]}
      />
    )

    expect(html).toContain('Subagents')
    expect(html).not.toContain('bg-purple-500')
    expect(html).not.toContain('animate-pulse')
    expect(html).not.toContain('aria-label="Subagents, 0 active subagents"')
  })

  test('keeps all tabs in the mobile select and renders desktop tabs at the lg breakpoint', () => {
    const html = renderToStaticMarkup(<AgentViewTabs activeTab="chat" onChange={mock()} tabs={tabs} collapseOnMobile />)

    expect(html).toContain('<option value="context">Context</option>')
    expect(html).toContain('hidden lg:flex')
    expect(html).not.toContain('More tabs')
    expect(html).toContain('Conversation options, Chat view')
  })

  test('mobile overflow selects a view and dismisses with Escape or an outside press', async () => {
    const dom = await installDom()
    const { root } = dom.createRoot()
    const onChange = mock()
    await dom.act(async () => root.render(<AgentViewTabs activeTab="chat" onChange={onChange} tabs={tabs} />))
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      '[aria-label="Conversation options, Chat view"]'
    )!
    await dom.act(async () => trigger.click())
    expect(dom.window.document.activeElement?.textContent).toBe('Chat')
    const menu = trigger.parentElement!
    const context = Array.from(menu.querySelectorAll('button')).find((button) => button.textContent === 'Context')!
    await dom.act(async () => context.click())
    expect(onChange).toHaveBeenCalledWith('context')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(dom.window.document.activeElement).toBe(trigger)
    await dom.act(async () => trigger.click())
    await dom.act(async () =>
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await dom.act(async () => trigger.click())
    await dom.act(async () =>
      dom.window.document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
    )
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  test.each(['null', 'body'] as const)(
    'a mobile tap with %s relatedTarget selects before dismissal',
    async (target) => {
      const dom = await installDom()
      const { root } = dom.createRoot()
      const onChange = mock()
      await dom.act(async () => root.render(<AgentViewTabs activeTab="chat" onChange={onChange} tabs={tabs} />))
      const trigger = dom.window.document.querySelector<HTMLButtonElement>(
        '[aria-label="Conversation options, Chat view"]'
      )!
      await dom.act(async () => trigger.click())
      const menu = trigger.parentElement!
      const context = Array.from(menu.querySelectorAll('button')).find((button) => button.textContent === 'Context')!
      await dom.act(async () => {
        context.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
        dom.window.document.activeElement!.dispatchEvent(
          new dom.window.FocusEvent('focusout', {
            bubbles: true,
            relatedTarget: target === 'body' ? dom.window.document.body : null,
          })
        )
      })
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(context.closest('[data-state]')?.getAttribute('data-state')).toBe('open')
      await dom.act(async () => context.click())
      expect(onChange).toHaveBeenCalledWith('context')
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
    }
  )

  test('keyboard focus leaving the menu still dismisses after a pointer opened it', async () => {
    const dom = await installDom()
    const { root, container } = dom.createRoot()
    await dom.act(async () => root.render(<AgentViewTabs activeTab="chat" onChange={mock()} tabs={tabs} />))
    const trigger = container.querySelector<HTMLButtonElement>('[aria-expanded]')!
    await dom.act(async () => {
      trigger.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
      trigger.click()
    })
    await dom.act(async () => {
      dom.window.document.activeElement!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })
      )
      dom.window.document.activeElement!.dispatchEvent(
        new dom.window.FocusEvent('focusout', { bubbles: true, relatedTarget: dom.window.document.body })
      )
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  test('selecting a tablet option calls onChange with the selected view', async () => {
    const dom = await installDom()
    const { window } = dom
    const { root } = domHarness!.createRoot()
    const onChange = mock()

    await domHarness!.act(async () => {
      root.render(<AgentViewTabs activeTab="chat" onChange={onChange} tabs={tabs} />)
    })

    const select = window.document.querySelector('select') as HTMLSelectElement
    select.value = 'context'
    await domHarness!.act(async () => {
      select.dispatchEvent(new window.Event('change', { bubbles: true }))
    })

    expect(onChange).toHaveBeenCalledWith('context')

    await domHarness!.act(async () => {
      root.unmount()
    })
  })
})

afterEach(async () => {
  await domHarness?.cleanup()
  domHarness = undefined
})
