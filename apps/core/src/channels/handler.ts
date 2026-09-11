/**
 * Shared Channel Event Handler
 *
 * Contains the common flow logic for handling channel events across providers.
 * Each provider normalizes their webhooks to ChannelEvent, then this handler
 * processes them uniformly.
 */

import { isTauSyncCommand } from '../lib/channels'
import type { ChannelProvider, ChannelEvent, ResponseContext, ThreadMessage } from './provider'
import { Agent } from '../entities/Agent'
import { InboxMessage } from '../entities/InboxMessage'
import { ChannelInstance } from '../entities/ChannelInstance'
import { createLogger } from '../lib/infra/logger'

const log = createLogger('channel-handler')

// =============================================================================
// Types
// =============================================================================

interface HandlerResult {
  /** Response to return to the webhook caller */
  response: unknown
  /** Whether to return empty body (provider posted response via API) */
  emptyResponse?: boolean
}

interface BuiltThreadHistory {
  content: string
  imageIds: string[]
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Handle a channel event.
 *
 * Flow:
 * 1. Slash command → post "Thinking..." parent → create thread → queue for concierge
 * 2. @mention in channel → post "Thinking..." in thread on user's message → queue
 * 3. @mention in any thread → fetch history since last Tau → respond
 * 4. Message in regular thread → ignore (Tau only responds to mentions)
 * 5. Message in reusable chat provider → route to the chat concierge
 */
export async function handleChannelEvent(
  provider: ChannelProvider,
  event: ChannelEvent,
  platformId: string
): Promise<HandlerResult> {
  log.info(`${provider.name}: handling ${event.type} from ${event.user.name}`)

  // Find channel instance
  const channelInstance = await ChannelInstance.findByProvider(provider.name, platformId)
  if (!channelInstance) {
    log.warn(`${provider.name}: no channel instance for platform ${platformId}`)
    return { response: provider.formatErrorResponse('This server/workspace is not configured.') }
  }

  // Handle sync commands (status, help, notify, unnotify)
  if (event.type === 'slash_command' && isTauSyncCommand(event.command || '')) {
    const response = await channelInstance.handleSyncCommand({
      command: event.command!,
      content: event.text,
      user: event.user,
      responseContext: buildResponseContext(provider, event),
    })

    // For providers that send via API (like Telegram), we need to send the message directly
    if (provider.sendsResponseViaApi) {
      await provider.postMessage({
        channelId: event.channelId,
        text: response,
        threadId: event.messageId, // Reply to user's message
      })
      return { response: { ok: true }, emptyResponse: true }
    }

    return { response: provider.formatSyncResponse(response) }
  }

  // Dispatch based on event type
  if (event.type === 'slash_command') {
    return handleSlashCommand(provider, event, channelInstance)
  } else if (event.type === 'mention') {
    return handleMention(provider, event, channelInstance, platformId)
  } else if (event.type === 'message') {
    return handleMessage(provider, event, channelInstance)
  }

  return { response: { ok: true } }
}

// =============================================================================
// Slash Command
// =============================================================================

async function handleSlashCommand(
  provider: ChannelProvider,
  event: ChannelEvent,
  channelInstance: ChannelInstance
): Promise<HandlerResult> {
  log.info(`${provider.name}: slash command '${event.command}' from ${event.user.name}`)

  // Check if command is in an existing active tracked thread. Terminated
  // concierges are ignored so a later command can start a replacement agent.
  const existingAgent = await Agent.findByThreadId(provider.name, event.channelId)
  if (existingAgent) {
    log.info(`${provider.name}: routing to existing agent ${existingAgent.id}`)

    await InboxMessage.send({
      recipientId: existingAgent.id,
      senderType: 'system',
      wakeEligible: true,
      subject: `Channel: ${event.command}`,
      content: `**${provider.name} ${event.command} from ${event.user.name}:** "${event.text}"`,
      metadata: {
        type: 'channel_message',
        channelContext: buildResponseContext(provider, event),
        userId: event.user.id,
        userName: event.user.name,
        command: event.command,
      },
    })

    return { response: provider.formatDeferredResponse() }
  }

  // Post "Thinking..." indicator (provider-specific)
  const thinkingResult = await provider.postThinkingIndicator(event)

  const responseContext = {
    ...buildResponseContext(provider, event),
    ...thinkingResult?.context,
  }

  // If this command is happening inside a previously tracked thread whose
  // concierge was terminated, findByThreadId() returns null. In that case,
  // include the thread history so the replacement concierge has the full
  // conversation context.
  const threadHistory = event.isInThread
    ? await buildThreadHistory(
        provider,
        { ...event, threadId: event.threadId ?? event.channelId },
        { includeAll: true }
      )
    : { content: event.text, imageIds: [] }

  // Queue for concierge
  await channelInstance.queueForConcierge({
    command: event.command || 'ask',
    content: threadHistory.content || event.text,
    ...(threadHistory.imageIds.length ? { imageIds: threadHistory.imageIds } : {}),
    user: event.user,
    responseContext,
  })

  log.info(`${provider.name}: queued ${event.command} for concierge`)

  // Return based on provider's preference
  if (thinkingResult?.emptyResponse) {
    return { response: null, emptyResponse: true }
  }

  return { response: provider.formatDeferredResponse() }
}

// =============================================================================
// Mention
// =============================================================================

async function handleMention(
  provider: ChannelProvider,
  event: ChannelEvent,
  channelInstance: ChannelInstance,
  _platformId: string
): Promise<HandlerResult> {
  if (event.isInThread && event.threadId) {
    // Mention in a thread - fetch history and respond, regardless of who created the thread.
    const existingAgent = await Agent.findByThreadId(provider.name, event.threadId)
    return handleMentionInJoinedThread(provider, event, channelInstance, existingAgent)
  } else {
    // Mention in channel (not in thread) - create thread on user's message
    return handleMentionInChannel(provider, event, channelInstance)
  }
}

async function handleMentionInChannel(
  provider: ChannelProvider,
  event: ChannelEvent,
  channelInstance: ChannelInstance
): Promise<HandlerResult> {
  log.info(`${provider.name}: mention in channel, creating thread`)

  // Post "Thinking..." as reply to user's message (creates thread). Providers
  // can override this to perform provider-specific setup first (for example,
  // Slack joins public channels before posting so app_mention can work even when
  // the bot is not already a member).
  const thinkingMsg = provider.postMentionThinkingIndicator
    ? await provider.postMentionThinkingIndicator(event)
    : await provider.postMessage({
        channelId: event.channelId,
        text: '_Thinking..._',
        threadId: event.messageId, // Reply to user's message
      })

  const threadHistory = await buildThreadHistory(
    provider,
    { ...event, threadId: event.messageId },
    { includeAll: true }
  )

  await channelInstance.queueForConcierge({
    command: 'mention',
    content: threadHistory.content || event.text,
    ...(threadHistory.imageIds.length ? { imageIds: threadHistory.imageIds } : {}),
    user: event.user,
    responseContext: {
      provider: provider.name,
      channelId: event.channelId,
      threadId: event.messageId, // User's message is the thread parent
      messageToEdit: thinkingMsg.messageId,
      tauInitiated: true, // Tau is creating this thread
      extras: event.raw,
    },
  })

  return { response: { ok: true } }
}

async function handleMentionInJoinedThread(
  provider: ChannelProvider,
  event: ChannelEvent,
  channelInstance: ChannelInstance,
  existingAgent: Agent | null
): Promise<HandlerResult> {
  log.info(`${provider.name}: mention in thread, fetching history`)

  // Fetch thread history
  const threadHistory = await buildThreadHistory(provider, event, { includeAll: !existingAgent })

  // Post "Thinking..." in thread
  const thinkingMsg = await provider.postMessage({
    channelId: event.channelId,
    text: '_Thinking..._',
    threadId: event.threadId,
  })

  const responseContext: ResponseContext = {
    provider: provider.name,
    channelId: event.channelId,
    threadId: event.threadId,
    messageToEdit: thinkingMsg.messageId,
    tauInitiated: false,
    extras: event.raw,
  }

  const content =
    threadHistory.content || `${event.user.name || provider.formatUserMention(event.user.id)}: ${event.text}`

  if (existingAgent) {
    // Reuse existing agent
    log.info(`${provider.name}: routing to existing agent ${existingAgent.id} (joined thread)`)

    await InboxMessage.send({
      recipientId: existingAgent.id,
      senderType: 'system',
      wakeEligible: true,
      subject: 'Channel: mention',
      content,
      metadata: {
        type: 'channel_message',
        channelContext: responseContext,
        userId: event.user.id,
        userName: event.user.name,
        command: 'mention',
        ...(threadHistory.imageIds.length ? { imageIds: threadHistory.imageIds } : {}),
      },
    })
  } else {
    // Queue for new concierge
    await channelInstance.queueForConcierge({
      command: 'mention',
      content,
      ...(threadHistory.imageIds.length ? { imageIds: threadHistory.imageIds } : {}),
      user: event.user,
      responseContext,
    })
  }

  return { response: { ok: true } }
}

// =============================================================================
// Message (in thread)
// =============================================================================

async function handleMessage(
  provider: ChannelProvider,
  event: ChannelEvent,
  channelInstance?: ChannelInstance
): Promise<HandlerResult> {
  if (!event.isInThread || !event.threadId) {
    log.info(`${provider.name}: message not in thread, ignoring`)
    return { response: { ok: true } }
  }

  const agent = await Agent.findByThreadId(provider.name, event.threadId)

  // Some providers (like Telegram) reuse a single concierge per chat (no threads)
  const reusesChat = provider.reusesThreadForChat === true

  // For providers that reuse chats: create a concierge if none exists. Since
  // findByThreadId() ignores terminated agents, this also replaces terminated
  // chat concierges and includes available history below.
  if (!agent && reusesChat && channelInstance) {
    log.info(`${provider.name}: first active message in chat, creating concierge`)
    return handleNewChatMessage(provider, event, channelInstance)
  }

  // Threaded providers only respond to explicit mention events. Regular thread
  // messages are ignored even in Tau-created threads.
  if (!reusesChat) {
    log.info(`${provider.name}: regular thread message without mention, ignoring`)
    return { response: { ok: true } }
  }

  if (!agent) {
    log.info(`${provider.name}: message without existing chat concierge, ignoring`)
    return { response: { ok: true } }
  }

  log.info(`${provider.name}: routing message to agent ${agent.id}`)

  // Post "Thinking..." that will be edited with response
  const thinkingMsg = await provider.postMessage({
    channelId: event.channelId,
    text: '_Thinking..._',
    threadId: event.threadId, // Keep the response in the tracked parent thread
  })

  await InboxMessage.send({
    recipientId: agent.id,
    senderType: 'system',
    wakeEligible: true,
    subject: 'Channel: message',
    content: `**${provider.name} message from ${event.user.name || provider.formatUserMention(event.user.id)}:** "${event.text}"`,
    metadata: {
      type: 'channel_message',
      channelContext: {
        provider: provider.name,
        channelId: event.channelId,
        threadId: event.threadId,
        messageToEdit: thinkingMsg.messageId,
      },
      userId: event.user.id,
      userName: event.user.name,
      command: 'message',
    },
  })

  return { response: { ok: true } }
}

// =============================================================================
// Chat-based providers (no threads)
// =============================================================================

async function handleNewChatMessage(
  provider: ChannelProvider,
  event: ChannelEvent,
  channelInstance: ChannelInstance
): Promise<HandlerResult> {
  // Post "Thinking..." as reply to user's message
  const thinkingMsg = await provider.postMessage({
    channelId: event.channelId,
    text: '_Thinking..._',
    threadId: event.messageId,
  })

  const threadHistory = await buildThreadHistory(
    provider,
    { ...event, threadId: event.channelId },
    { includeAll: true }
  )

  await channelInstance.queueForConcierge({
    command: 'message',
    content: threadHistory.content || event.text,
    ...(threadHistory.imageIds.length ? { imageIds: threadHistory.imageIds } : {}),
    user: event.user,
    responseContext: {
      provider: provider.name,
      channelId: event.channelId,
      threadId: event.channelId, // Use chat ID as thread
      messageToEdit: thinkingMsg.messageId,
      tauInitiated: true, // Mark as Tau-initiated so future messages route here
    },
  })

  return { response: { ok: true } }
}

// =============================================================================
// Helpers
// =============================================================================

function buildResponseContext(provider: ChannelProvider, event: ChannelEvent): ResponseContext {
  return {
    provider: provider.name,
    channelId: event.channelId,
    threadId: event.threadId,
    extras: event.raw,
  }
}

async function buildThreadHistory(
  provider: ChannelProvider,
  event: ChannelEvent,
  options: { includeAll?: boolean } = {}
): Promise<BuiltThreadHistory> {
  if (!event.threadId) return { content: '', imageIds: [] }

  try {
    const messages = await provider.getThreadHistory(event.channelId, event.threadId, 50)
    const botUserId = await provider.getBotUserId()

    // Existing active concierges only need the messages since the last Tau
    // response. Replacement concierges need the full thread to recover context.
    let startIndex = 0
    if (!options.includeAll) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].isBotMessage) {
          startIndex = i
          break
        }
      }
    }

    // Filter out current message and build history
    const currentMessage = messages.find((m) => m.messageId === event.messageId)
    const historyMessages: ThreadMessage[] = [
      ...messages.slice(startIndex).filter((m) => m.messageId !== event.messageId),
      {
        messageId: event.messageId,
        userId: event.user.id,
        userName: event.user.name,
        text: currentMessage?.text ?? event.text,
        timestamp: currentMessage?.timestamp ?? '',
        isBotMessage: false,
        attachments: currentMessage?.attachments,
      },
    ]

    const imageIds = historyMessages.flatMap((m) =>
      (m.attachments ?? []).flatMap((attachment) => (attachment.imageId ? [attachment.imageId] : []))
    )

    const formatted = historyMessages
      .map((m) => {
        const userLabel = m.isBotMessage ? '@Tau' : m.userName || provider.formatUserMention(m.userId)
        const text = botUserId ? provider.replaceBotMention(m.text, botUserId) : m.text
        const attachments = formatThreadAttachments(m)
        return `${userLabel}: ${text}${attachments ? `\n\n${attachments}` : ''}`
      })
      .join('\n\n')

    if (formatted) {
      return { content: `**Thread history** (you are referenced as @Tau):\n\n${formatted}`, imageIds }
    }
  } catch (e) {
    log.warn(`Failed to fetch thread history: ${e}`)
  }

  return { content: '', imageIds: [] }
}

function formatThreadAttachments(message: ThreadMessage): string {
  const attachments = message.attachments ?? []
  if (attachments.length === 0) return ''

  const lines = attachments.map((attachment) => {
    const details = [
      attachment.title || attachment.id || 'attached file',
      attachment.mimeType,
      attachment.size ? `${Math.round(attachment.size / 1024)} KB` : undefined,
      attachment.imageId ? `available as image input ${attachment.imageId}` : undefined,
      attachment.permalink,
    ].filter(Boolean)
    return `- ${details.join(' — ')}`
  })

  return `Attachments:\n${lines.join('\n')}`
}
