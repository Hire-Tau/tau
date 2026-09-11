import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MigrateReasonNote } from './MigrateControl'

describe('MigrateReasonNote', () => {
  test('renders the refusal reason verbatim', () => {
    const html = renderToStaticMarkup(<MigrateReasonNote result={{ moved: false, reason: 'squad-box' }} />)
    expect(html).toContain('squad-box')
    expect(html).toContain('refused')
  })

  test('renders count-only context for active execution refusals', () => {
    const html = renderToStaticMarkup(
      <MigrateReasonNote result={{ moved: false, reason: 'active-turn', activeExecutionCount: 3 }} />
    )
    expect(html).toContain('active-turn (3 active executions)')
  })

  test('renders a generic label when a refusal has no reason', () => {
    const html = renderToStaticMarkup(<MigrateReasonNote result={{ moved: false }} />)
    expect(html).toContain('failed')
  })

  test('renders nothing for a successful move', () => {
    const html = renderToStaticMarkup(<MigrateReasonNote result={{ moved: true }} />)
    expect(html).toBe('')
  })

  test('renders nothing when there is no result yet', () => {
    const html = renderToStaticMarkup(<MigrateReasonNote result={undefined} />)
    expect(html).toBe('')
  })
})
