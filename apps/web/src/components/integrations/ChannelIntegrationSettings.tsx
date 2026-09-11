import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  configureChannelIntegration,
  slackAppManifestUrl,
  type ChannelIntegrationSettings as View,
} from '../../api/integrations'
import { usePermissions } from '../../hooks/usePermissions'
import { integrationQueries, queries } from '../../queryOptions'
import { integrationQueryKeys, queryKeys } from '../../queryKeys'
import { ChannelsSection } from '../settings/ChannelsSection'
import type { ProviderId } from '../settings/channelFormHelpers'
import { useSquadsApi } from '../settings/squadsApi'
import { IntegrationCredentialSettings } from './IntegrationCredentialSettings'

const identityLabels: Record<string, string> = {
  botId: 'Bot ID',
  username: 'Bot username',
  teamId: 'Workspace ID',
  teamName: 'Workspace',
  botUserId: 'Bot user ID',
  applicationId: 'Application ID',
  publicKey: 'Public key',
  guildId: 'Server ID',
}

const providerHints: Record<ProviderId, { where: string; what: string }> = {
  telegram: {
    where: 'Message @BotFather, send /newbot, and paste the token it gives you.',
    what: 'Tau registers the webhook with Telegram itself — no secrets to generate, no URLs to paste.',
  },
  slack: {
    where:
      'Create the app from the manifest below, install it to your workspace, then paste the bot token and signing secret from its settings.',
    what: 'The manifest already carries this instance’s URLs; commands and events reach Tau as soon as the app is installed.',
  },
  discord: {
    where: 'In the Discord Developer Portal create an application, reset its bot token, and paste it here.',
    what: 'Tau discovers the application and its public key, registers the /tau commands, and connects the gateway. Set the Interactions Endpoint URL below in the portal.',
  },
}

export function ChannelIntegrationSettings({ provider, canWrite }: { provider: ProviderId; canWrite: boolean }) {
  const permissions = usePermissions()
  const client = useQueryClient()
  const view = useQuery(integrationQueries.credentialSettings(provider, 'channel'))
  const { listSquads } = useSquadsApi()
  const { data: squads = [] } = useQuery({ ...queries.squads.list(), queryFn: () => listSquads() })
  const data = view.data as View | undefined
  const [guildId, setGuildId] = useState('')
  useEffect(() => setGuildId(data?.identity?.guildId ?? ''), [data?.identity?.guildId])

  const invalidate = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: integrationQueryKeys.all }),
      client.invalidateQueries({ queryKey: queryKeys.channelInstances.all }),
    ])
  const setRouting = useMutation({
    mutationFn: (input: Record<string, string | null>) => configureChannelIntegration(provider, input),
    onSuccess: () => invalidate(),
  })

  const hint = providerHints[provider]
  const connected = data?.connection?.source === 'connection' && data.connection.authState === 'authenticated'
  const routingReady = !!data?.identity && (provider !== 'discord' || !!data.identity.guildId)

  return (
    <div className="space-y-6">
      <div className="space-y-1 text-sm">
        <p className="text-muted">{hint.where}</p>
        <p className="text-muted">{hint.what}</p>
        {provider === 'slack' && (
          <a className="text-accent underline" href={slackAppManifestUrl} download="tau-slack-app-manifest.yaml">
            Download the Slack app manifest for this instance
          </a>
        )}
      </div>

      <IntegrationCredentialSettings provider={provider} canWrite={canWrite} />

      {data && (
        <section className="space-y-3 text-sm" aria-label="Connection status">
          <h4 className="font-medium text-primary">Connection</h4>
          {data.setup?.state === 'needs_attention' ? (
            <p role="alert" className="text-danger">
              {data.setup.issues.join(' ')}
            </p>
          ) : data.setup?.state === 'needs_setup' ? (
            <p className="text-muted">Save the credential above to connect.</p>
          ) : (
            <p className="text-muted">
              {connected ? 'Connected and validated.' : 'Configured from environment secrets.'}
              {data.enabled === false && ' The provider is switched off; credentials are kept.'}
            </p>
          )}
          {data.identity && Object.keys(data.identity).length > 0 && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              {Object.entries(data.identity)
                .filter(([key]) => key !== 'publicKey')
                .map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-muted">{identityLabels[key] ?? key}</dt>
                    <dd className="font-mono text-primary break-all">{value}</dd>
                  </div>
                ))}
            </dl>
          )}
          {data.webhook && provider !== 'telegram' && (
            <div>
              <div className="text-muted">
                {provider === 'discord' ? 'Interactions Endpoint URL' : 'Request URL (slash commands and events)'}
              </div>
              <code className="block font-mono text-xs text-primary break-all select-all">{data.webhook.url}</code>
            </div>
          )}
        </section>
      )}

      {data && (
        <section className="space-y-3 text-sm" aria-label="Default squad">
          <h4 className="font-medium text-primary">Default squad</h4>
          {provider === 'discord' && data.guilds && data.guilds.length > 1 && (
            <div className="space-y-1">
              <label htmlFor={`${provider}-guild`} className="block text-muted">
                Server the bot answers in
              </label>
              <select
                id={`${provider}-guild`}
                className="tau-field w-full text-sm bg-surface-secondary border border-th-border rounded px-2 py-1 text-primary"
                value={guildId}
                disabled={!canWrite || setRouting.isPending}
                onChange={(event) => {
                  setGuildId(event.target.value)
                  setRouting.mutate({ guildId: event.target.value || null })
                }}
              >
                <option value="">Choose a server…</option>
                {data.guilds.map((guild) => (
                  <option key={guild.id} value={guild.id}>
                    {guild.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {provider === 'discord' && data.guilds && data.guilds.length === 0 && (
            <p className="text-muted">Invite the bot to a server first; it will appear here.</p>
          )}
          {routingReady ? (
            <div className="space-y-1">
              <label htmlFor={`${provider}-default-squad`} className="block text-muted">
                Messages go to this squad unless a routing override below matches
              </label>
              <select
                id={`${provider}-default-squad`}
                className="tau-field w-full text-sm bg-surface-secondary border border-th-border rounded px-2 py-1 text-primary"
                value={data.routing?.defaultSquadId ?? ''}
                disabled={!canWrite || setRouting.isPending}
                onChange={(event) => setRouting.mutate({ defaultSquadId: event.target.value || null })}
              >
                <option value="">None</option>
                {squads.map((squad) => (
                  <option key={squad.id} value={squad.id}>
                    {squad.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            data.setup?.state === 'configured' &&
            provider === 'discord' && <p className="text-muted">Choose the server above to pick a default squad.</p>
          )}
          {setRouting.isError && (
            <p role="alert" className="text-danger">
              {setRouting.error.message}
            </p>
          )}
        </section>
      )}

      {!permissions.isLoading && !permissions.isError && permissions.can('channels:read') && (
        <ChannelsSection provider={provider} />
      )}
    </div>
  )
}
