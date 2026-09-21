import { describe, expect, test } from 'bun:test'
import { WORK_STREAM_STATUS_ROLE, type WorkStreamPresentationState } from '@tau/shared'
import { WS_STATUS_BADGE_COLORS, WS_STATUS_LABELS, getWsDisplayState } from './workStreamStatusPresentation'
import { BADGE_COLORS } from '../components/Badge'

describe('work-stream role token resolution', () => {
  test('every stored and derived state retains its shared semantic role', () => {
    expect(Object.keys(WS_STATUS_BADGE_COLORS).sort()).toEqual(Object.keys(WORK_STREAM_STATUS_ROLE).sort())
    for (const state of Object.keys(WORK_STREAM_STATUS_ROLE) as WorkStreamPresentationState[]) {
      const role = WORK_STREAM_STATUS_ROLE[state]
      expect(WS_STATUS_BADGE_COLORS[state]).toBe(role)
      expect(WS_STATUS_LABELS[state].length).toBeGreaterThan(0)
      expect(BADGE_COLORS[role]).toContain(
        `bg-status-${role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}-badge-surface`
      )
    }
  })
  test('derived review still takes precedence over stored active', () => {
    expect(getWsDisplayState({ status: 'active', derivedState: 'in_review' })).toBe('in_review')
    expect(WS_STATUS_BADGE_COLORS.in_review).toBe('review')
    expect(WS_STATUS_BADGE_COLORS.active).toBe('progress')
  })
})
