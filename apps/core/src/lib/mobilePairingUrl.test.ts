import { afterEach, describe, expect, test } from 'bun:test'
import { buildMobilePairingServerUrl } from './mobilePairingUrl'

const originalAppBasePath = process.env.APP_BASE_PATH

afterEach(() => {
  if (originalAppBasePath === undefined) delete process.env.APP_BASE_PATH
  else process.env.APP_BASE_PATH = originalAppBasePath
})

describe('buildMobilePairingServerUrl', () => {
  test('includes the configured app base path with the browser origin', () => {
    process.env.APP_BASE_PATH = '/tau'
    expect(
      buildMobilePairingServerUrl({
        requestUrl: 'http://localhost:3000/api/auth/pair/start',
        originHeader: 'https://home.example.com',
      })
    ).toBe('https://home.example.com/tau')
  })

  test('derives a base path from the request URL when no configured base path is present', () => {
    delete process.env.APP_BASE_PATH
    expect(buildMobilePairingServerUrl({ requestUrl: 'https://home.example.com/tau/api/auth/pair/start' })).toBe(
      'https://home.example.com/tau'
    )
  })
})
