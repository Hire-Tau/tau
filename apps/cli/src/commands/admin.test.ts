import { describe, expect, it } from 'bun:test'
import { Command } from 'commander'
import { buildWorkspaceGcRequest, registerAdminCommands } from './admin'

describe('admin workspace-gc command', () => {
  it('registers bounded apply, limit, and cursor options', () => {
    const program = new Command()
    registerAdminCommands(program)
    const admin = program.commands.find((command) => command.name() === 'admin')
    const gc = admin?.commands.find((command) => command.name() === 'workspace-gc')

    expect(gc).toBeDefined()
    expect(gc?.options.map((option) => option.long).sort()).toEqual(['--apply', '--cursor', '--limit'])
    expect(gc?.description()).toContain('dry-run')
  })

  it('keeps dry-run request empty by default', () => {
    expect(buildWorkspaceGcRequest({})).toEqual({})
  })

  it('forwards apply and paging options with a numeric limit', () => {
    expect(buildWorkspaceGcRequest({ apply: true, limit: '1000', cursor: 'opaque' })).toEqual({
      apply: true,
      limit: 1000,
      cursor: 'opaque',
    })
  })

  it('rejects a non-numeric limit before calling the API', () => {
    expect(() => buildWorkspaceGcRequest({ limit: 'nope' })).toThrow('limit')
  })
})
