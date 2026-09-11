// Thin shim over @tau/client-core (see ./clientInstance).
import { client } from './clientInstance'

export type { ChatSSECallbacks } from '@tau/client-core'

export const sendChatMessage = client.chat.sendChatMessage
