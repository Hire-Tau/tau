import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { WORK_STREAM_PRESENTATION_CASES } from '../../../../packages/shared/src/test-fixtures/work-stream-presentation'
import { WorkStreamStatusBadges } from './WorkStreamStatusBadges'
import { getWsDisplayState, WS_STATUS_BADGE_COLORS } from '../lib/workStreamStatusPresentation'
import { webStatus } from '../lib/statusPresentation'

for (const row of WORK_STREAM_PRESENTATION_CASES) {
  test(`visible status matrix: ${row.name}`, () => {
    const html = renderToStaticMarkup(<WorkStreamStatusBadges workStream={row.facts} />)
    expect(html).toContain(row.label)
    expect(WS_STATUS_BADGE_COLORS[getWsDisplayState(row.facts)]).toBe(webStatus(row.role).badgeColor)
  })
}
