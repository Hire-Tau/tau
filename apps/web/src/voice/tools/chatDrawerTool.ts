import { getChatDrawerPath, type ChatDrawerToolState } from '../chatDrawerTool'
import type { VoiceAssistantTool, VoiceToolExecutor } from './types'

export const chatDrawerTool: VoiceAssistantTool<VoiceToolExecutor> = {
  definition: {
    type: 'function',
    name: 'set_chat_drawer',
    description:
      'Open, collapse, expand, or toggle the shared Assistant popup in the top right. Text and Voice are separate conversations in this surface. Closing while voice is live keeps a compact voice strip; it does not end the call.',
    parameters: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['open', 'closed', 'expanded', 'toggle'],
          description:
            'Desired Assistant state. Open shows the popup, closed hides it or compacts live voice, expanded enlarges an already open Text conversation, and toggle switches visibility.',
        },
      },
      required: ['state'],
    },
  },
  followUp: 'never',
  async execute(args, executor) {
    const { state } = args as { state: ChatDrawerToolState }
    const currentPath = executor.getCurrentPath?.() ?? `${window.location.pathname}${window.location.search}`
    const path = getChatDrawerPath(currentPath, state)
    executor.navigate(path)
    return { ok: true, drawerState: state, navigatedTo: path }
  },
}

export const chatDrawerTools = [chatDrawerTool]
