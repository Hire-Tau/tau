import { expect, test } from 'bun:test'
import { notionPlugin } from '../notion/plugin'
import { projectIntegrationAssignments } from './projector'
import { resolveEffectiveToolchain } from './effective-toolchain'

const connection = {
  id: 'connection',
  providerKey: 'notion',
  adapterVersion: 1,
  configuration: { version: 1, workspaceId: 'workspace', workspaceName: null, workspaceIcon: null, botId: 'bot' },
  credentialRef: 'credential',
  materialRevision: 'revision',
}

test('effective toolchain preserves squad metadata and appends stable plugin contributions', () => {
  const squadConfig = { packages: ['python@3.12', 'nodejs@24.12.0'], setupScript: 'echo squad-owned' }
  const before = JSON.stringify(squadConfig)
  const projection = projectIntegrationAssignments([{ plugin: notionPlugin, connection }])
  const effective = resolveEffectiveToolchain(squadConfig, projection.publicDeclaration)

  expect(JSON.stringify(squadConfig)).toBe(before)
  expect(effective.config).toEqual({
    packages: ['nodejs@24.12.0', 'python@3.12'],
    setupScript: `echo squad-owned\n${notionPlugin.sandbox.setupSteps[0].script}`,
  })
  expect(effective.initHooks).toEqual(notionPlugin.sandbox.initHooks)
  expect(effective.readiness).toEqual(notionPlugin.sandbox.readiness)
})
