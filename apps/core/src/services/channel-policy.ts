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

export async function requireAllowedChannelReply(
  instanceId: string | undefined,
  channelId: string,
  directAgentId?: string
): Promise<void> {
  const { ChannelInstance } = await import('../entities/ChannelInstance')
  const instance = instanceId ? await ChannelInstance.find(instanceId) : null
  if (!instance) throw new Error('Channel connection no longer exists')
  await requireAllowedChannel(instance, channelId)
  if (directAgentId) {
    const { db, channelDirectAgents, channelDirectChats, channelIdentityLinks } = await import('../db')
    const { and, eq } = await import('drizzle-orm')
    const { findLinkedChannelUser } = await import('./channel-access')
    const { hasUserPermissionWithExecutor } = await import('./rbac/permissions')
    const [binding] = await db
      .select()
      .from(channelDirectAgents)
      .innerJoin(channelDirectChats, eq(channelDirectChats.id, channelDirectAgents.chatId))
      .innerJoin(channelIdentityLinks, eq(channelIdentityLinks.id, channelDirectChats.linkId))
      .where(
        and(
          eq(channelDirectAgents.agentId, directAgentId),
          eq(channelDirectChats.channelId, channelId),
          eq(channelIdentityLinks.instanceId, instance.id)
        )
      )
    const link = binding && (await findLinkedChannelUser(instance, binding.channel_identity_links.externalUserId))
    if (
      !link ||
      link.id !== binding.channel_identity_links.id ||
      !(await hasUserPermissionWithExecutor(db, link.userId, 'chat:send', binding.channel_direct_agents.squadId))
    ) {
      throw new Error('Private conversation access was revoked')
    }
  }
}
