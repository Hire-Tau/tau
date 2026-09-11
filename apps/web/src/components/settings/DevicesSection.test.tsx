import { describe, expect, it } from 'bun:test'
import { devicePlatformLabel } from './deviceAuthorizationApprovalLogic'

describe('Paired Devices platform labels', () => {
  it('renders known platforms and safely falls back for unknown values', () => {
    expect(['ios', 'android', 'cli', 'future'].map(devicePlatformLabel)).toEqual([
      'iOS',
      'Android',
      'Tau CLI',
      'Device',
    ])
  })
})
