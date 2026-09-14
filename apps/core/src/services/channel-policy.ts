interface ChannelPolicy {
  disabled: boolean
  allowedChannelIds?: string[]
  deniedChannelIds?: string[]
}

/** Pass the native parent channel ID for threads. Denial precedes all sender trust. */
export function isChannelAllowed(policy: ChannelPolicy, channelId: string): boolean {
  return (
    !policy.disabled &&
    !!channelId &&
    !(policy.deniedChannelIds ?? []).includes(channelId) &&
    (!policy.allowedChannelIds?.length || policy.allowedChannelIds.includes(channelId))
  )
}

/** Resolve Discord's native parent for delayed replies and configured notification destinations. */
export async function requireAllowedChannel(
  instance: ChannelPolicy & { provider: string },
  channelId: string
): Promise<void> {
  if (instance.disabled) throw new Error('This channel connection is disabled')
  let policyChannelId = channelId
  if (instance.provider === 'discord' && (instance.allowedChannelIds?.length || instance.deniedChannelIds?.length)) {
    const { getChannelIntegrationValue } = await import('./integrations/channels/settings')
    const token = getChannelIntegrationValue('DISCORD_BOT_TOKEN')
    if (!token) throw new Error('Cannot verify Discord channel policy')
    const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error('Cannot verify Discord channel policy')
    const channel = (await response.json()) as { type: number; parent_id?: string }
    if ([10, 11, 12].includes(channel.type)) {
      if (!channel.parent_id) throw new Error('Cannot verify Discord thread parent')
      policyChannelId = channel.parent_id
    }
  }
  if (!isChannelAllowed(instance, policyChannelId)) throw new Error('Channel excluded by administrator policy')
}

export async function requireAllowedChannelReply(instanceId: string | undefined, channelId: string): Promise<void> {
  const { ChannelInstance } = await import('../entities/ChannelInstance')
  const instance = instanceId ? await ChannelInstance.find(instanceId) : null
  if (!instance) throw new Error('Channel connection no longer exists')
  await requireAllowedChannel(instance, channelId)
}
