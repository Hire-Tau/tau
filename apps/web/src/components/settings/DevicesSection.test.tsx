import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { deviceApprovalErrorMessage, devicePlatformLabel } from './deviceAuthorizationApprovalLogic'
import { DeviceAuthorizationApproval } from './DeviceAuthorizationApproval'

describe('Paired Devices platform labels', () => {
  it('renders known platforms and safely falls back for unknown values', () => {
    expect(['ios', 'android', 'cli', 'desktop', 'future'].map(devicePlatformLabel)).toEqual([
      'iOS',
      'Android',
      'Tau CLI',
      'Tau Desktop',
      'Device',
    ])
  })

  it('labels desktop devices and phrases approval by platform', () => {
    expect(devicePlatformLabel('desktop')).toBe('Tau Desktop')
    expect(deviceApprovalErrorMessage(new Error(), 'desktop')).toBe(
      'Approval failed because this request is expired or already used. Start again from Tau Desktop.'
    )
    expect(deviceApprovalErrorMessage(new Error(), 'cli')).toContain('tau auth login')
  })
})

describe('DeviceAuthorizationApproval heading by platform', () => {
  const expiresAt = '2030-01-01T12:00:00.000Z'

  it('renders the Tau Desktop heading for a desktop pairing request', () => {
    const html = renderToStaticMarkup(
      <DeviceAuthorizationApproval preview={{ name: 'MacBook', platform: 'desktop', expiresAt }} onApprove={() => {}} />
    )
    expect(html).toContain('Approve Tau Desktop sign-in')
  })

  it('renders the Tau CLI heading for a cli pairing request', () => {
    const html = renderToStaticMarkup(
      <DeviceAuthorizationApproval preview={{ name: 'atlas', platform: 'cli', expiresAt }} onApprove={() => {}} />
    )
    expect(html).toContain('Approve Tau CLI login')
  })
})
