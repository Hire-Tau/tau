import { describe, expect, test } from 'bun:test'

import { presentationSchema } from './presentationSchema'

describe('presentationSchema', () => {
  test('accepts markdown, html, metrics, table, callout, timeline, and Vega-Lite chart blocks', () => {
    const result = presentationSchema.safeParse({
      schemaVersion: 1,
      title: 'Sales Pipeline Overview',
      sections: [
        {
          id: 'summary',
          title: 'Summary',
          blocks: [
            { type: 'markdown', content: 'Pipeline is healthy overall.' },
            {
              type: 'html',
              iframeAccessibilityTitle: 'Custom card',
              content: '<div style="padding: 1rem">Hello</div>',
            },
            {
              type: 'metrics',
              items: [{ label: 'Open deals', value: '42', tone: 'info' }],
            },
            {
              type: 'table',
              columns: [
                { key: 'name', label: 'Name' },
                { key: 'status', label: 'Status' },
              ],
              rows: [{ name: 'Acme', status: 'Open' }],
            },
            {
              type: 'callout',
              title: 'Watch item',
              content: 'Enterprise deals are slipping.',
              tone: 'warning',
            },
            {
              type: 'timeline',
              items: [{ title: 'Discovery', at: '2026-04-01', content: 'Initial review completed.' }],
            },
            {
              type: 'chart',
              library: 'vega-lite',
              spec: {
                mark: 'bar',
                encoding: { x: { field: 'status' }, y: { aggregate: 'count' } },
                data: { values: [{ status: 'Open' }] },
              },
            },
          ],
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  test('rejects an unknown block type', () => {
    const result = presentationSchema.safeParse({
      schemaVersion: 1,
      title: 'Unknown Block',
      sections: [
        {
          id: 'summary',
          blocks: [{ type: 'video', content: 'Unsupported' }],
        },
      ],
    })

    expect(result.success).toBe(false)
  })

  test('rejects chart blocks that do not use Vega-Lite', () => {
    const result = presentationSchema.safeParse({
      schemaVersion: 1,
      title: 'Invalid Chart',
      sections: [
        {
          id: 'summary',
          blocks: [{ type: 'chart', library: 'chartjs', spec: {} }],
        },
      ],
    })

    expect(result.success).toBe(false)
  })

  test('accepts bounded HTML sizing metadata', () => {
    const result = presentationSchema.safeParse({
      schemaVersion: 1,
      title: 'Sized HTML',
      sections: [
        {
          id: 'main',
          blocks: [{ type: 'html', content: '<div>Hi</div>', height: 640, minHeight: 240, maxHeight: 1600 }],
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  test.each([
    ['height below lower bound', { height: 119 }],
    ['height above upper bound', { height: 4001 }],
    ['fractional height', { height: 640.5 }],
    ['minHeight below lower bound', { minHeight: 119 }],
    ['maxHeight above upper bound', { maxHeight: 4001 }],
    ['minHeight greater than maxHeight', { minHeight: 1000, maxHeight: 200 }],
  ])('rejects HTML sizing metadata with %s', (_name, sizing) => {
    const result = presentationSchema.safeParse({
      schemaVersion: 1,
      title: 'Bad HTML',
      sections: [{ id: 'main', blocks: [{ type: 'html', content: '<div>Hi</div>', ...sizing }] }],
    })

    expect(result.success).toBe(false)
  })

  test.each([
    ['empty presentation title', { schemaVersion: 1, title: '', sections: [] }],
    [
      'empty section id',
      {
        schemaVersion: 1,
        title: 'Presentation',
        sections: [{ id: '', blocks: [{ type: 'markdown', content: 'Content' }] }],
      },
    ],
    [
      'empty markdown content',
      {
        schemaVersion: 1,
        title: 'Presentation',
        sections: [{ id: 'summary', blocks: [{ type: 'markdown', content: '' }] }],
      },
    ],
    [
      'empty metric label',
      {
        schemaVersion: 1,
        title: 'Presentation',
        sections: [{ id: 'summary', blocks: [{ type: 'metrics', items: [{ label: '', value: '42' }] }] }],
      },
    ],
    [
      'legacy HTML title metadata',
      {
        schemaVersion: 1,
        title: 'Presentation',
        sections: [{ id: 'summary', blocks: [{ type: 'html', title: 'Custom card', content: '<div>Content</div>' }] }],
      },
    ],
    [
      'unknown block key',
      {
        schemaVersion: 1,
        title: 'Presentation',
        sections: [{ id: 'summary', blocks: [{ type: 'markdown', content: 'Content', extra: true }] }],
      },
    ],
  ])('rejects %s', (_name, presentation) => {
    const result = presentationSchema.safeParse(presentation)

    expect(result.success).toBe(false)
  })
})
