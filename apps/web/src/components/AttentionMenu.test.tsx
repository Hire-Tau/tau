import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Attention } from '@tau/shared'
import { queryKeys } from '../queryKeys'
import { AttentionMenu } from './AttentionMenu'

function renderSquad(attention: Attention, subscribed = true): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.squadSubscription.detail('squad-1'), { subscribed, count: 3, attention })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AttentionMenu target={{ kind: 'squad', id: 'squad-1' }} />
    </QueryClientProvider>
  )
}

function renderStream(attention: Attention, inherited: boolean): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.workStreamSubscription.detail('ws-1'), {
    subscribed: !inherited,
    count: 1,
    attention,
    inherited,
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AttentionMenu target={{ kind: 'workStream', id: 'ws-1' }} />
    </QueryClientProvider>
  )
}

const radio = (html: string, label: string) => html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0]

describe('AttentionMenu', () => {
  test('summarizes equal levels in one word and a mix as Custom', () => {
    expect(renderSquad({ decisions: 'notify', progress: 'notify' })).toContain('Notify')
    expect(renderSquad({ decisions: 'show', progress: 'show' }, false)).toContain('Show')
    expect(renderSquad({ decisions: 'mute', progress: 'mute' })).toContain('Muted')
    expect(renderSquad({ decisions: 'notify', progress: 'mute' })).toContain('Custom')
  })

  test('offers both kinds with their helper text and checks the current level of each', () => {
    const html = renderSquad({ decisions: 'notify', progress: 'mute' })
    expect(html).toContain('Decisions')
    expect(html).toContain('Questions, reviews, and blockers')
    expect(html).toContain('Progress')
    expect(html).toContain('Active work and completions')

    expect(radio(html, 'Decisions: Notify')).toContain('checked')
    expect(radio(html, 'Decisions: Mute')).not.toContain('checked')
    expect(radio(html, 'Progress: Mute')).toContain('checked')
    expect(radio(html, 'Progress: Notify')).not.toContain('checked')
  })

  test('a work stream shows its inheritance and the reset action only while inheriting', () => {
    const inheriting = renderStream({ decisions: 'notify', progress: 'notify' }, true)
    expect(inheriting).toContain('Inherits from squad')
    expect(inheriting).not.toContain('Reset to squad')

    const overridden = renderStream({ decisions: 'mute', progress: 'mute' }, false)
    expect(overridden).not.toContain('Inherits from squad')
    expect(overridden).toContain('Reset to squad')
  })

  test('a squad menu never offers stream inheritance copy', () => {
    const html = renderSquad({ decisions: 'show', progress: 'show' }, false)
    expect(html).not.toContain('Inherits from squad')
    expect(html).not.toContain('Reset to squad')
  })
})
