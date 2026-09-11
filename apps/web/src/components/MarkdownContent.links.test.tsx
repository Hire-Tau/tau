import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownContent } from './MarkdownContent'

const url = 'https://github.com/example/project/pull/42'

describe('compact Action Center PR links', () => {
  test('shortens a bare PR URL without changing its destination', () => {
    const html = renderToStaticMarkup(<MarkdownContent compactPullRequestLinks>{`Review ${url}`}</MarkdownContent>)
    expect(html).toContain(`href="${url}"`)
    expect(html).toContain(`title="${url}"`)
    expect(html).toContain('>PR #1440</a>')
  })

  test('preserves authored labels, other URLs, and ordinary markdown elsewhere', () => {
    const named = renderToStaticMarkup(
      <MarkdownContent compactPullRequestLinks>{`[Review the OAuth changes](${url})`}</MarkdownContent>
    )
    expect(named).toContain('>Review the OAuth changes</a>')
    const other = 'https://example.com/pull/1440'
    expect(renderToStaticMarkup(<MarkdownContent compactPullRequestLinks>{other}</MarkdownContent>)).toContain(
      `>${other}</a>`
    )
    expect(renderToStaticMarkup(<MarkdownContent>{url}</MarkdownContent>)).toContain(`>${url}</a>`)
  })
})
