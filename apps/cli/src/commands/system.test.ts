import { beforeAll, describe, expect, it } from 'bun:test'
import { Command } from 'commander'
import { buildSystemLogsWsRequest, buildSystemLogsWsUrl, registerSystemCommands } from './system'

describe('system CLI commands', () => {
  let systemCommand: Command | undefined

  beforeAll(() => {
    const program = new Command()
    program.exitOverride()
    registerSystemCommands(program)
    systemCommand = program.commands.find((command) => command.name() === 'system')
  })

  it('exposes maintenance, restart, and logs subcommands', () => {
    expect(systemCommand?.commands.map((command) => command.name()).sort()).toEqual([
      'logs',
      'pause',
      'pause-status',
      'restart',
      'resume',
    ])
  })

  it('supports an optional maintenance reason', () => {
    const pause = systemCommand?.commands.find((command) => command.name() === 'pause')
    expect(pause?.options.some((option) => option.long === '--reason')).toBe(true)
  })

  it('supports component, tail, and follow flags for logs', () => {
    const logs = systemCommand?.commands.find((command) => command.name() === 'logs')
    expect(logs?.options.find((option) => option.long === '--component')?.defaultValue).toBe('all')
    expect(logs?.options.find((option) => option.long === '--tail')?.defaultValue).toBe('500')
    expect(logs?.options.some((option) => option.long === '--follow')).toBe(true)
  })
})

describe('buildSystemLogsWsUrl', () => {
  it('builds ws URL from http API URL and clamps tail', () => {
    expect(
      buildSystemLogsWsUrl({
        apiUrl: 'http://localhost:3000/',
        token: 'tok',
        component: 'api',
        tail: 99999,
        follow: false,
      })
    ).toBe('ws://localhost:3000/ws/system/logs?component=api&tailLines=5000&follow=false')
  })

  it('builds wss URL from https API URL', () => {
    expect(buildSystemLogsWsUrl({ apiUrl: 'https://tau.example', component: 'all', tail: 100, follow: true })).toBe(
      'wss://tau.example/ws/system/logs?component=all&tailLines=100'
    )
  })

  it('keeps the bearer out of the URL and sends it as a header', () => {
    const request = buildSystemLogsWsRequest({
      apiUrl: 'https://tau.example',
      token: 'secret',
      component: 'all',
      tail: 100,
      follow: true,
    })
    expect(request.url).not.toContain('secret')
    expect(request.headers).toEqual({ Authorization: 'Bearer secret' })
  })
})
