import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { IncludePickerView } from './IncludePicker'

describe('IncludePickerView', () => {
  const all = [
    { id: 'rules', name: 'Rules', disabled: false },
    { id: 'squad-rules', name: 'Squad rules', disabled: false },
    { id: 'old', name: 'Old', disabled: true },
  ]
  test('renders selected includes in order with move/remove controls', () => {
    const html = renderToStaticMarkup(
      <IncludePickerView value={['squad-rules', 'rules']} all={all} onChange={() => {}} />
    )
    expect(html.indexOf('Squad rules')).toBeLessThan(html.indexOf('Rules'))
    expect(html).toContain('aria-label="Move squad-rules up"')
    expect(html).toContain('aria-label="Remove rules"')
  })
  test('offers only enabled, unselected includes to add', () => {
    const html = renderToStaticMarkup(<IncludePickerView value={['rules']} all={all} onChange={() => {}} />)
    expect(html).toContain('<option value="squad-rules">')
    expect(html).not.toContain('<option value="rules">')
    expect(html).not.toContain('<option value="old">')
  })
})
