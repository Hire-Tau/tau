import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiGet, apiPost, apiPut, apiDelete } from '../client'
import { setOutputOptions } from '../output'
import { registerAgentQuestionCommands } from './agent-question'
import { registerAgentCommands } from './agent'
import { registerSquadCommands } from './squad'
import { registerWorkstreamCommands } from './workstream'
import { registerNotificationConfigCommands } from './notification-config'

type AnyMock = ReturnType<typeof mock>

function makeRunner(register: (program: Command) => void) {
  return async (args: string[]): Promise<void> => {
    const program = new Command()
    program.exitOverride()
    program.option('--json')
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    register(program)
    await program.parseAsync(['--quiet', ...args], { from: 'user' })
  }
}

describe('CLI commands for new routes', () => {
  beforeEach(() => {
    for (const fn of [apiGet, apiPost, apiPut, apiDelete, setOutputOptions] as AnyMock[]) fn.mockClear()
    ;(apiGet as AnyMock).mockResolvedValue([])
    ;(apiPost as AnyMock).mockResolvedValue({})
    ;(apiPut as AnyMock).mockResolvedValue({})
    ;(apiDelete as AnyMock).mockResolvedValue({})
  })

  it('agent-question list hits GET /api/agent-questions/by-agent/:id with status', async () => {
    await makeRunner(registerAgentQuestionCommands)(['agent-question', 'list', 'agent-1', '--status', 'open'])
    expect(apiGet).toHaveBeenCalledWith('/api/agent-questions/by-agent/agent-1?status=open')
  })

  it('agent-question answer hits POST /api/agent-questions/:id/answer', async () => {
    ;(apiPost as AnyMock).mockResolvedValue({ id: 'q-1', status: 'answered' })
    await makeRunner(registerAgentQuestionCommands)(['agent-question', 'answer', 'q-1', 'Yes, ship it'])
    expect(apiPost).toHaveBeenCalledWith('/api/agent-questions/q-1/answer', { answer: 'Yes, ship it' })
  })

  it('agent-question dismiss hits DELETE /api/agent-questions/:id with an optional reason', async () => {
    ;(apiDelete as AnyMock).mockResolvedValue({ id: 'q-1', status: 'dismissed' })
    await makeRunner(registerAgentQuestionCommands)(['agent-question', 'dismiss', 'q-1', '--reason', 'stale'])
    expect(apiDelete).toHaveBeenCalledWith('/api/agent-questions/q-1', { reason: 'stale' })
  })

  it('agent-question dismiss omits the body and enables JSON output when requested', async () => {
    ;(apiDelete as AnyMock).mockResolvedValue({ id: 'q-2', status: 'dismissed' })
    await makeRunner(registerAgentQuestionCommands)(['agent-question', 'dismiss', 'q-2', '--json'])
    expect(apiDelete).toHaveBeenCalledWith('/api/agent-questions/q-2', undefined)
    expect(setOutputOptions).toHaveBeenCalledWith(expect.objectContaining({ json: true }))
  })

  it('agent continue hits POST /api/agents/:id/continue', async () => {
    ;(apiPost as AnyMock).mockResolvedValue({ resumed: true })
    await makeRunner(registerAgentCommands)(['agent', 'continue', 'agent-1'])
    expect(apiPost).toHaveBeenCalledWith('/api/agents/agent-1/continue')
  })

  it('agent continue-halted hits POST /api/agents/continue-halted', async () => {
    ;(apiPost as AnyMock).mockResolvedValue({ resumed: 3 })
    await makeRunner(registerAgentCommands)(['agent', 'continue-halted'])
    expect(apiPost).toHaveBeenCalledWith('/api/agents/continue-halted')
  })

  it('squad subscribe hits POST /api/squads/:id/subscribe', async () => {
    ;(apiPost as AnyMock).mockResolvedValue({ subscribed: true, count: 1 })
    await makeRunner(registerSquadCommands)(['squad', 'subscribe', 'squad-1'])
    expect(apiPost).toHaveBeenCalledWith('/api/squads/squad-1/subscribe')
  })

  it('squad unsubscribe hits DELETE /api/squads/:id/subscribe', async () => {
    ;(apiDelete as AnyMock).mockResolvedValue({ subscribed: false, count: 0 })
    await makeRunner(registerSquadCommands)(['squad', 'unsubscribe', 'squad-1'])
    expect(apiDelete).toHaveBeenCalledWith('/api/squads/squad-1/subscribe')
  })

  it('workstream subscribe hits POST /api/workstreams/:id/subscribe', async () => {
    ;(apiPost as AnyMock).mockResolvedValue({ subscribed: true, count: 1 })
    await makeRunner(registerWorkstreamCommands)(['workstream', 'subscribe', 'ws-1'])
    expect(apiPost).toHaveBeenCalledWith('/api/workstreams/ws-1/subscribe')
  })

  it('workstream subscription hits GET /api/workstreams/:id/subscription', async () => {
    ;(apiGet as AnyMock).mockResolvedValue({ subscribed: true, count: 2 })
    await makeRunner(registerWorkstreamCommands)(['workstream', 'subscription', 'ws-1'])
    expect(apiGet).toHaveBeenCalledWith('/api/workstreams/ws-1/subscription')
  })

  it('notification-config set-mine hits PUT /api/notification-config/me', async () => {
    ;(apiPut as AnyMock).mockResolvedValue({ pushEnabled: false, mutedEvents: ['x'] })
    await makeRunner(registerNotificationConfigCommands)([
      'notification-config',
      'set-mine',
      '--push-enabled',
      'false',
      '--muted',
      'x, y',
    ])
    expect(apiPut).toHaveBeenCalledWith('/api/notification-config/me', {
      pushEnabled: false,
      mutedEvents: ['x', 'y'],
    })
  })
})
