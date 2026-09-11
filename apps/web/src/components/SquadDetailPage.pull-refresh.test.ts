import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'SquadDetailPage.tsx'), 'utf8')

describe('SquadDetailPage pull-to-refresh wiring', () => {
  test('wraps the Home tab with the shared pull-to-refresh component', () => {
    expect(source).toContain('data-testid="squad-home-pull-to-refresh"')
    expect(source).toContain('onRefresh={refreshSquadHome}')
  })

  test('wraps the Work tab with the shared pull-to-refresh component', () => {
    expect(source).toContain('data-testid="squad-work-pull-to-refresh"')
    expect(source).toContain('onRefresh={refreshSquadWork}')
  })

  test('refreshes the query keys backing squad Home and Work data', () => {
    expect(source).toContain('queryKeys.squads.activeWorkStreams(resolvedId)')
    expect(source).toContain('queryKeys.squads.agentsWithRecent(resolvedId)')
    expect(source).toContain('queryKeys.squads.doneWorkStreamsInfinite(resolvedId, DONE_WORK_STREAM_STATUSES_KEY)')
  })

  test('documents why both short and resolved squad detail keys are invalidated', () => {
    expect(source).toContain('short prefix route can resolve to a full UUID')
  })
})
