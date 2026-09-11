import { usePermissions } from '../../hooks/usePermissions'
import { ChannelsSection } from '../settings/ChannelsSection'
import type { ProviderId } from '../settings/channelFormHelpers'
import { IntegrationCredentialSettings } from './IntegrationCredentialSettings'

export function ChannelIntegrationSettings({ provider, canWrite }: { provider: ProviderId; canWrite: boolean }) {
  const permissions = usePermissions()
  return (
    <div className="space-y-6">
      <IntegrationCredentialSettings provider={provider} canWrite={canWrite} />
      {!permissions.isLoading && !permissions.isError && permissions.can('channels:read') && (
        <ChannelsSection provider={provider} />
      )}
    </div>
  )
}
