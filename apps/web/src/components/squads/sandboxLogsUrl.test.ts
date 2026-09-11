import { describe, test, expect } from 'bun:test'
import { buildSandboxLogsPath } from './sandboxLogsUrl'

describe('buildSandboxLogsPath', () => {
  test('encodes the sandbox id in the path and adds a ticket', () => {
    const path = buildSandboxLogsPath({ sandboxId: 'squad_a/b', ticket: 't1' })
    expect(path).toBe('/sandbox/squad_a%2Fb/logs?ticket=t1')
  })
  test('includes tailLines and previous when set', () => {
    const path = buildSandboxLogsPath({ sandboxId: 'squad_a', tailLines: 500, previous: true, token: 'tok' })
    expect(path).toBe('/sandbox/squad_a/logs?token=tok&tailLines=500&previous=true')
  })
  test('omits previous when false and tailLines when undefined', () => {
    expect(buildSandboxLogsPath({ sandboxId: 'squad_a', ticket: 't' })).toBe('/sandbox/squad_a/logs?ticket=t')
  })
})
