import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SharedPromptPickerView } from './SharedPromptPicker'

describe('SharedPromptPickerView', () => {
  const all = [
    { id: 'rules', name: 'Rules', disabled: false },
    { id: 'squad-rules', name: 'Squad rules', disabled: false },
    { id: 'old', name: 'Old', disabled: true },
  ]
  test('renders selected includes in order with move/remove controls', () => {
    const html = renderToStaticMarkup(
      <SharedPromptPickerView value={['squad-rules', 'rules']} all={all} onChange={() => {}} />
    )
    expect(html.indexOf('Squad rules')).toBeLessThan(html.indexOf('Rules'))
    expect(html).toContain('aria-label="Move squad-rules up"')
    expect(html).toContain('aria-label="Remove rules"')
  })
  test('offers only enabled, unselected includes to add', () => {
    const html = renderToStaticMarkup(<SharedPromptPickerView value={['rules']} all={all} onChange={() => {}} />)
    expect(html).toContain('<option value="squad-rules">')
    expect(html).not.toContain('<option value="rules">')
    expect(html).not.toContain('<option value="old">')
  })
})

describe('SharedPromptPickerView while the catalog loads', () => {
  // The Agent Types tab never fetches /shared-prompts, so the catalog query is
  // cold when an editor first opens. Flagging every configured id as "missing"
  // during that round trip invites the operator to delete rows that are fine.
  const html = renderToStaticMarkup(
    <SharedPromptPickerView value={['rules', 'squad-rules']} all={[]} onChange={() => {}} loading />
  )

  test('keeps the configured rows without flagging them as missing', () => {
    expect(html).toContain('rules')
    expect(html).toContain('squad-rules')
    expect(html).not.toContain('missing')
  })

  test('shows a loading hint instead of claiming no includes are available', () => {
    expect(html).toContain('Loading shared prompts…')
    expect(html).not.toContain('No more shared prompts available')
  })

  test('disables the reorder and remove controls until the catalog settles', () => {
    expect(html).toContain('aria-label="Remove rules" disabled=""')
    expect(html).toContain('aria-label="Move squad-rules up" disabled=""')
  })
})
