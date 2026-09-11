import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'InboxPage.tsx'), 'utf8')

describe('InboxPage pull-to-refresh wiring', () => {
  test('wraps the Inbox page with the shared pull-to-refresh component', () => {
    expect(source).toContain("import { PullToRefresh } from './PullToRefresh'")
    expect(source).toContain('<PullToRefresh')
    expect(source).toContain('id="inbox-pull-to-refresh"')
    expect(source).toContain('onRefresh={refreshInbox}')
    expect(source).toContain('label="inbox"')
    expect(source).toContain('data-testid="inbox-pull-to-refresh"')
    expect(source).toContain('className="h-full"')
  })

  test('refreshes inbox, visible system inbox, and squad label data', () => {
    expect(source).toMatch(
      /const invalidateInboxes = useCallback\([\s\S]*queryKeys\.inbox\.minePrefix\(\)[\s\S]*if \(canSystem\)[\s\S]*queryKeys\.inbox\.systemPrefix\(\)/
    )
    expect(source).toMatch(/const refreshInbox = useCallback[\s\S]*invalidateInboxes\(\)[\s\S]*queryKeys\.squads\.all/)
  })
})
