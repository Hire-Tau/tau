import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const chatView = readFileSync(join(import.meta.dir, 'ChatView.tsx'), 'utf8')

describe('disabled chat accessibility contract', () => {
  test('renders persistent live copy linked to the disabled composer', () => {
    expect(chatView).toContain('id="chat-input-disabled-reason"')
    expect(chatView).toContain('role="status"')
    expect(chatView).toContain('aria-live="polite"')
    expect(chatView).toContain("aria-describedby={inputDisabledReason ? 'chat-input-disabled-reason' : undefined}")
  })
})
