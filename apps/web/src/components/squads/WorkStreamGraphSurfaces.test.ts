import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const shared = readFileSync(join(import.meta.dir, 'WorkStreamList.tsx'), 'utf8')
const home = readFileSync(join(import.meta.dir, 'SquadHomeTab.tsx'), 'utf8')
const detail = readFileSync(join(import.meta.dir, '..', 'SquadDetailPage.tsx'), 'utf8')

describe('shared squad work-stream graph surfaces', () => {
  test('uses the same squad WorkStreamList component on home and the dedicated work tab', () => {
    expect(home).toContain("import { WorkStreamList } from './WorkStreamList'")
    expect(detail).toContain("import { WorkStreamList } from './squads/WorkStreamList'")
    expect(home).toContain('<WorkStreamListComponent')
    expect(detail).toContain('<WorkStreamList')
  })

  test('owns graph, toggle, empty state, and modal behavior in the shared component', () => {
    expect(shared).toContain("import { WorkStreamGraph } from '../WorkStreamGraph'")
    expect(shared).toContain("import { WorkStreamViewToggle, useWorkStreamViewMode } from '../WorkStreamViewToggle'")
    expect(shared.match(/<WorkStreamGraph/g)).toHaveLength(1)
    expect(shared).toContain('<WorkStreamViewToggle squadId={squadId} surface={surface} modes={modes}')
    expect(shared).toContain("const WORK_VIEW_MODES = ['list', 'kanban', 'graph']")
    expect(shared).toContain('<WorkStreamDetailModal')
  })

  test('the compact Home explorer is a list inline and the dependency graph in its dialog, with no toggle', () => {
    expect(shared).not.toContain('HOME_VIEW_MODES')
    expect(shared).toContain("const viewMode = compact ? 'list' : workViewMode")
    expect(shared.match(/compact && inFullscreen \? 'graph' : viewMode/g)).toHaveLength(2)
    expect(shared).toContain('title="Work Stream Graph"')
    expect(shared).not.toContain('headerActions={<WorkStreamViewToggle')
    expect(shared).toContain('aria-label="Show work stream graph"')
  })
})
