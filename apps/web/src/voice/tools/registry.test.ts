import { describe, expect, test } from 'bun:test'
import { createVoiceToolRegistry } from './registry'
import type { VoiceAssistantTool } from './types'

interface TestEnv {
  prefix: string
}

const echoTool: VoiceAssistantTool<TestEnv> = {
  definition: {
    type: 'function',
    name: 'echo',
    description: 'Echo a value',
    parameters: { type: 'object' },
  },
  async execute(args, env) {
    return { value: `${env.prefix}${String(args.value)}` }
  },
  summarizeCall(args) {
    return `echoing ${String(args.value)}`
  },
  followUp: (result) => Boolean((result as { value?: string }).value),
}

const errorTool: VoiceAssistantTool<TestEnv> = {
  definition: {
    type: 'function',
    name: 'error_tool',
    description: 'Returns a tool error',
    parameters: { type: 'object' },
  },
  async execute() {
    return { error: 'Useful tool failure detail' }
  },
}

const plainTool: VoiceAssistantTool<TestEnv> = {
  definition: {
    type: 'function',
    name: 'plain',
    description: 'Plain tool',
    parameters: { type: 'object' },
  },
  async execute(args) {
    return args
  },
}

describe('createVoiceToolRegistry', () => {
  test('exposes definitions and executes registered tools with follow-up policy', async () => {
    const registry = createVoiceToolRegistry([echoTool])

    expect(registry.definitions).toEqual([echoTool.definition])
    expect(registry.get('echo')).toBe(echoTool)
    await expect(registry.execute('echo', { value: 'hello' }, { prefix: '>' })).resolves.toEqual({
      result: { value: '>hello' },
      followUp: true,
    })
  })

  test('throws useful errors for unknown tools and tool error results', async () => {
    const registry = createVoiceToolRegistry([echoTool, errorTool])

    await expect(registry.execute('missing', {}, { prefix: '' })).rejects.toThrow('Unknown tool: missing')
    await expect(registry.execute('error_tool', {}, { prefix: '' })).rejects.toThrow('Useful tool failure detail')
  })

  test('summarizes calls with custom or default formatting', () => {
    const registry = createVoiceToolRegistry([echoTool, plainTool])

    expect(registry.summarizeCall('echo', { value: 'hello' })).toBe('echoing hello')
    expect(registry.summarizeCall('plain', { a: 1, b: 'two' })).toBe('a: 1, b: two')
    expect(registry.summarizeCall('missing', { a: 1 })).toBe('a: 1')
  })
})
