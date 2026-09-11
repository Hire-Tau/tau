import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const detailSource = readFileSync(join(import.meta.dir, 'SquadDetailPage.tsx'), 'utf8')
const homeSource = readFileSync(join(import.meta.dir, 'squads', 'SquadHomeTab.tsx'), 'utf8')
const styles = readFileSync(join(import.meta.dir, '..', 'index.css'), 'utf8')

describe('Squad Home responsive summary', () => {
  test('keeps a bounded summary scroller and separate Chats destination', () => {
    expect(detailSource).toContain('data-active-tab={activeTab}')
    expect(homeSource).toContain('squad-home-layout flex h-full min-h-0 w-full flex-col gap-5 overflow-y-auto')
    expect(homeSource).toContain('squad-home-work-streams shrink-0')
    expect(homeSource).not.toContain('squad-home-agents')
    expect(styles).not.toContain('min-height: 32rem')
  })
})
