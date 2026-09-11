import { describe, expect, test } from 'bun:test'
import {
  ACTIVE_PLATFORM_UPDATE_STATUSES,
  assertPlatformUpdateStatus,
  assertTenantUpgradeScope,
  PLATFORM_UPDATE_CLAIM_BLOCKING_STATUSES,
  PLATFORM_UPDATE_STATUSES,
  PLATFORM_UPDATE_STATUS_META,
  TENANT_UPGRADE_SCOPES,
  isActivePlatformUpdateStatus,
  isTerminalPlatformUpdateStatus,
  platformUpdateBlocksJobClaims,
} from './platform-updates'

const EXPECTED_STATUSES = [
  'checking',
  'checked',
  'queued',
  'staging',
  'preflighting',
  'draining',
  'activating',
  'verifying',
  'rolling_back',
  'succeeded',
  'failed',
  'rolled_back',
] as const

describe('platform update lifecycle contract', () => {
  test('exhaustively classifies every lifecycle status', () => {
    expect(PLATFORM_UPDATE_STATUSES).toEqual([...EXPECTED_STATUSES])
    expect(Object.keys(PLATFORM_UPDATE_STATUS_META)).toEqual([...EXPECTED_STATUSES])

    for (const status of PLATFORM_UPDATE_STATUSES) {
      expect(Object.keys(PLATFORM_UPDATE_STATUS_META[status]).sort()).toEqual([
        'active',
        'blocksJobClaims',
        'label',
        'terminal',
      ])
      expect(PLATFORM_UPDATE_STATUS_META[status].label.length).toBeGreaterThan(0)
    }
  })

  test('renders queued work as an active starting phase', () => {
    expect(PLATFORM_UPDATE_STATUS_META.queued).toMatchObject({
      active: true,
      terminal: false,
      label: 'Starting',
    })
  })

  test('derives exact active, terminal, and job-claim semantics', () => {
    expect(ACTIVE_PLATFORM_UPDATE_STATUSES).toEqual([
      'queued',
      'staging',
      'preflighting',
      'draining',
      'activating',
      'verifying',
      'rolling_back',
    ])
    expect(PLATFORM_UPDATE_CLAIM_BLOCKING_STATUSES).toEqual(['draining', 'activating', 'verifying', 'rolling_back'])
    expect(PLATFORM_UPDATE_STATUSES.filter(isTerminalPlatformUpdateStatus)).toEqual([
      'checked',
      'succeeded',
      'failed',
      'rolled_back',
    ])
    expect(PLATFORM_UPDATE_STATUSES.filter(isActivePlatformUpdateStatus)).toEqual(ACTIVE_PLATFORM_UPDATE_STATUSES)
    expect(PLATFORM_UPDATE_STATUSES.filter(platformUpdateBlocksJobClaims)).toEqual(
      PLATFORM_UPDATE_CLAIM_BLOCKING_STATUSES
    )
  })

  test('parses only canonical lifecycle statuses', () => {
    expect(assertPlatformUpdateStatus('preflighting')).toBe('preflighting')
    expect(() => assertPlatformUpdateStatus('running')).toThrow('Invalid platform update status')
    expect(() => assertPlatformUpdateStatus(null)).toThrow('Invalid platform update status')
  })

  test('parses only canonical tenant upgrade scopes', () => {
    expect(TENANT_UPGRADE_SCOPES).toEqual(['none', 'all', 'selected'])
    expect(assertTenantUpgradeScope('selected')).toBe('selected')
    expect(() => assertTenantUpgradeScope('fleet')).toThrow('Invalid tenant upgrade scope')
    expect(() => assertTenantUpgradeScope(null)).toThrow('Invalid tenant upgrade scope')
  })
})
