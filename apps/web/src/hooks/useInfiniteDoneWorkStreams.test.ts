import { describe, expect, test } from 'bun:test'
import { DONE_WORK_STREAM_STATUSES_KEY, WS_DONE_STATUSES, workStreamStatusesKey } from '../api/squads'

describe('workStreamStatusesKey', () => {
  test('sorts statuses to match React Query done work stream cache keys consistently', () => {
    expect(workStreamStatusesKey(['canceled', 'done'])).toBe('canceled,done')
    expect(workStreamStatusesKey(['done', 'canceled'])).toBe('canceled,done')
    expect(DONE_WORK_STREAM_STATUSES_KEY).toBe(workStreamStatusesKey(WS_DONE_STATUSES))
  })
})
