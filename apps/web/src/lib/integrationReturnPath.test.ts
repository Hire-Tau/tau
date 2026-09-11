import { expect, test } from 'bun:test'
import { integrationReturnPath, integrationSettingsPath } from './integrationReturnPath'

for (const provider of ['github', 'notion'] as const) {
  test(`${provider} authorization opens its integration card at root and mounted deployments`, () => {
    for (const base of ['/', '/tau-gh-smoke/']) {
      const destination = `${base}settings?section=integrations&setting=integration-${provider}`
      expect(integrationSettingsPath(provider, base)).toBe(destination)
      expect(integrationReturnPath('/settings', provider, base)).toBe(destination)
      expect(integrationReturnPath(`${base}settings/`, provider, base)).toBe(destination)
      expect(integrationReturnPath(destination, provider, base)).toBe(destination)
    }
  })
}

test('callback preserves onboarding and custom return destinations', () => {
  for (const destination of ['/onboarding', '/tau/onboarding', '/squads/test?tab=settings', '/settings-other']) {
    expect(integrationReturnPath(destination, 'github', '/tau/')).toBe(destination)
  }
  expect(integrationReturnPath('/settings?section=account&setting=old&other=value#anchor', 'notion')).toBe(
    '/settings?section=integrations&setting=integration-notion&other=value#anchor'
  )
})
