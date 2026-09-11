import { describe, expect, it } from 'bun:test'
import { LocalDeploymentLogPathOutsideWorkspaceError } from './local-deployment-log-path'
import {
  normalizeLocalDeploymentInput,
  normalizeLocalDeploymentName,
  validateLocalDeploymentPort,
} from './local-deployment-validation'

const SQUAD = '11111111-2222-4333-8444-555555555555'

describe('localDeployment validation', () => {
  it('accepts user app ports', () => {
    expect(validateLocalDeploymentPort(5173)).toBe(5173)
  })

  it('rejects privileged and invalid ports', () => {
    expect(() => validateLocalDeploymentPort(0)).toThrow('Port must be between 1024 and 65535')
    expect(() => validateLocalDeploymentPort(80)).toThrow('Port must be between 1024 and 65535')
    expect(() => validateLocalDeploymentPort(70000)).toThrow('Port must be between 1024 and 65535')
  })

  it('defaults to private managed localDeployments', () => {
    expect(
      normalizeLocalDeploymentInput({ name: 'Web App', port: 5173, command: 'bun run dev' }, { squadId: SQUAD })
    ).toMatchObject({
      name: 'web-app',
      port: 5173,
      visibility: 'private',
      mode: 'managed',
      restartPolicy: 'always',
    })
  })

  it('normalizes localDeployment names', () => {
    expect(normalizeLocalDeploymentName(' API Server! ')).toBe('api-server')
  })

  it('requires command for managed localDeployments', () => {
    expect(() =>
      normalizeLocalDeploymentInput({ name: 'web', port: 5173, mode: 'managed' }, { squadId: SQUAD })
    ).toThrow('Managed localDeployments require a command')
  })

  it('rejects public localDeployments until explicitly supported', () => {
    expect(() =>
      normalizeLocalDeploymentInput(
        { name: 'web', port: 5173, command: 'bun run dev', visibility: 'public' },
        { squadId: SQUAD }
      )
    ).toThrow('Public localDeployments are not supported yet')
  })

  it('normalizes an attached logPath against the squad workspace', () => {
    const out = normalizeLocalDeploymentInput(
      { name: 'Web', mode: 'attached', port: 5173, logPath: 'my-app/app.log' },
      { squadId: SQUAD }
    )
    expect(out.logPath).toBe(`/workspace/${SQUAD}/my-app/app.log`)
  })

  it('drops the logPath when blank and nulls it when absent', () => {
    expect(
      normalizeLocalDeploymentInput({ name: 'Web', mode: 'attached', port: 5173 }, { squadId: SQUAD }).logPath
    ).toBeNull()
    expect(
      normalizeLocalDeploymentInput({ name: 'Web', mode: 'attached', port: 5173, logPath: '  ' }, { squadId: SQUAD })
        .logPath
    ).toBeNull()
  })

  it('rejects logPath on managed deployments', () => {
    expect(() =>
      normalizeLocalDeploymentInput({ name: 'Web', command: 'bun run dev', logPath: 'app.log' }, { squadId: SQUAD })
    ).toThrow(/attached/)
  })

  it('rejects an escaping logPath', () => {
    expect(() =>
      normalizeLocalDeploymentInput(
        { name: 'Web', mode: 'attached', port: 5173, logPath: '../../etc/passwd' },
        { squadId: SQUAD }
      )
    ).toThrow(LocalDeploymentLogPathOutsideWorkspaceError)
  })
})
