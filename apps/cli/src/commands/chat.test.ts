import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Command } from 'commander'
import { apiPostSSE } from '../client'
import { outputError } from '../output'
import { registerChatCommands } from './chat'

type AnyMock = ReturnType<typeof mock>

async function run(args: string[]) {
  const program = new Command()
  program.exitOverride()
  registerChatCommands(program)
  await program.parseAsync(args, { from: 'user' })
}

// The chat stream interleaves keepalive `ping` events (empty data) and events
// the CLI does not render (thinking, flush_agent, system_message) with the
// chunks it prints. Only `agent`, `chunk` and `done` carry data the CLI reads.
const agentEvent = JSON.stringify({ type: 'agent', agentId: 'agent-1' })

describe('tau chat', () => {
  beforeEach(() => {
    ;(apiPostSSE as AnyMock).mockClear()
    ;(outputError as AnyMock).mockClear()
  })

  it('prints streamed chunks and ignores keepalive pings with empty data', async () => {
    ;(apiPostSSE as AnyMock).mockImplementation(
      async (_path: string, _body: unknown, onEvent: (event: string, data: string) => void) => {
        onEvent('agent', agentEvent)
        onEvent('ping', '')
        onEvent('chunk', JSON.stringify({ type: 'chunk', text: 'PO' }))
        onEvent('ping', '')
        onEvent('chunk', JSON.stringify({ type: 'chunk', text: 'NG' }))
        onEvent('done', JSON.stringify({ type: 'done' }))
      }
    )
    const written: string[] = []
    const stdout = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await run(['chat', 'Reply with PONG'])
    } finally {
      stdout.mockRestore()
      log.mockRestore()
    }

    expect(apiPostSSE).toHaveBeenCalledWith('/api/chat', { message: 'Reply with PONG' }, expect.any(Function))
    expect(written.join('')).toBe('PONG')
    expect(outputError).not.toHaveBeenCalled()
  })

  it('ignores events it does not render even when their data is not JSON', async () => {
    ;(apiPostSSE as AnyMock).mockImplementation(
      async (_path: string, _body: unknown, onEvent: (event: string, data: string) => void) => {
        onEvent('agent', agentEvent)
        onEvent('thinking', JSON.stringify({ type: 'thinking', text: 'The user wants' }))
        onEvent('flush_agent', 'not json')
        onEvent('done', JSON.stringify({ type: 'done' }))
      }
    )
    const stdout = spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write)
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await run(['chat', 'hello'])
    } finally {
      stdout.mockRestore()
      log.mockRestore()
    }

    expect(outputError).not.toHaveBeenCalled()
  })
})
