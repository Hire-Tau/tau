import { buildVoiceNavigationGuide } from '../navigationGuide'
import type { VoiceAssistantTool, VoiceToolExecutor } from './types'

export const navigationTool: VoiceAssistantTool<VoiceToolExecutor> = {
  definition: {
    type: 'function',
    name: 'navigate',
    description: buildVoiceNavigationGuide(),
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Route path with optional query params, e.g. "/squads/abc123?agent=def456" or "/squads/abc123/work"',
        },
      },
      required: ['path'],
    },
  },
  followUp: 'never',
  async execute(args, executor) {
    const { path } = args as { path: string }
    executor.navigate(path)
    return { ok: true, navigatedTo: path }
  },
}

export const navigationTools = [navigationTool]
