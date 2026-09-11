/**
 * Channel Abstraction
 *
 * Provides bidirectional communication with external platforms.
 */

// Provider abstraction
export * from './provider'
export { handleChannelEvent } from './handler'

// Provider implementations
export { slackProvider, getSlackApi, hasSlackBotToken, joinChannel } from './slack/index'
export {
  discordProvider,
  InteractionResponseType,
  InteractionResponseTypes,
  editInteractionResponse,
  createThread,
} from './discord/index'
export { telegramProvider } from './telegram/index'

// Register providers on module load
import { registerProvider } from './provider'
import { slackProvider } from './slack/index'
import { discordProvider } from './discord/index'
import { telegramProvider } from './telegram/index'

registerProvider(slackProvider)
registerProvider(discordProvider)
registerProvider(telegramProvider)
