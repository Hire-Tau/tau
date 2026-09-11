import { describe, expect, it } from 'bun:test'
import { buildSystemLogsPath } from './systemLogsUrl'

describe('buildSystemLogsPath', () => {
  it('builds default path with ticket', () => {
    expect(buildSystemLogsPath({ ticket: 't1' })).toBe('/system/logs?ticket=t1')
  })

  it('builds path with component and tailLines', () => {
    expect(buildSystemLogsPath({ component: 'api', tailLines: 500, ticket: 't1' })).toBe(
      '/system/logs?ticket=t1&component=api&tailLines=500'
    )
  })

  it('includes follow=false when specified', () => {
    expect(buildSystemLogsPath({ component: 'worker', tailLines: 100, follow: false })).toBe(
      '/system/logs?component=worker&tailLines=100&follow=false'
    )
  })

  it('omits follow=true and component=all defaults', () => {
    expect(buildSystemLogsPath({ component: 'all', follow: true, ticket: 't' })).toBe('/system/logs?ticket=t')
  })

  it('never accepts a long-lived bearer option', () => {
    expect(buildSystemLogsPath({})).toBe('/system/logs')
  })
})
