import { expect, test } from 'bun:test'
import { Pm2LogProvider, buildPm2LogsArgs } from './pm2-provider'

test('builds finite PM2 argv and reports actionable failure', async () => {
  expect(buildPm2LogsArgs('tau-api', { tailLines: 25, follow: false })).toContain('--nostream')
  const errors: Error[] = []
  const provider = new Pm2LogProvider(
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
  expect(errors[0].message).toContain('PM2 availability')
})
