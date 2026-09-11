import { expect, test } from 'bun:test'
import { notionPlugin } from '../notion/plugin'
import { projectIntegrationAssignments } from './projector'
import { resolveProtectedBindings } from './protected-env'

const connection = {
  id: 'connection',
  providerKey: 'notion',
  adapterVersion: 1,
  configuration: { version: 1, workspaceId: 'workspace-id', workspaceName: null, workspaceIcon: null, botId: 'bot' },
  credentialRef: 'credential-ref',
  materialRevision: 'revision',
}

test('resolves protected bindings in sorted order without exposing refresh material', async () => {
  const projection = projectIntegrationAssignments([{ plugin: notionPlugin, connection }], {
    resolveCredential: async () =>
      JSON.stringify({
        version: 1,
        accessToken: "access-'token",
        refreshToken: 'refresh-TOKEN-SENTINEL',
        expiresAt: null,
        tokenRevision: 1,
      }),
  })
  expect(await resolveProtectedBindings(projection)).toEqual([
    ['NOTION_API_TOKEN', "access-'token"],
    ['NOTION_WORKSPACE_ID', 'workspace-id'],
  ])
})

test('missing or invalid credential material fails closed', async () => {
  const missing = projectIntegrationAssignments([{ plugin: notionPlugin, connection }])
  await expect(resolveProtectedBindings(missing)).rejects.toThrow('protected_binding_unavailable')
})
