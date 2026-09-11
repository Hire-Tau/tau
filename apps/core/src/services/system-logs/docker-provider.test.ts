import { expect, test } from 'bun:test'
import { DockerLogProvider, buildDockerLogsArgs } from './docker-provider'

test('builds fixed Docker argv', () => {
  expect(buildDockerLogsArgs('tau-api', { tailLines: 100, follow: true })).toEqual([
    'docker',
    'logs',
    '--tail',
    '100',
    '--follow',
    'tau-api',
  ])
})

test('omits follow for finite Docker streams', () => {
  expect(buildDockerLogsArgs('tau-worker', { tailLines: 100, follow: false })).toEqual([
    'docker',
    'logs',
    '--tail',
    '100',
    'tau-worker',
  ])
})

test('reports actionable sanitized Docker failure', async () => {
  const errors: Error[] = []
  const provider = new DockerLogProvider(
    { api: 'tau-api', worker: 'tau-worker' },
    { spawn: () => ({ stdout: null, stderr: null, exited: Promise.resolve(1), kill() {} }) }
  )
  provider.stream(
    ['api'],
    { tailLines: 1, follow: false },
    () => {},
    (error) => errors.push(error)
  )
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(errors[0].message).toContain('daemon access')
})
