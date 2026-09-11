import { expect, test } from 'bun:test'
import { SystemdLogProvider, buildJournalctlArgs } from './systemd-provider'

test('builds fixed journald argv', () => {
  expect(buildJournalctlArgs('tau-api', { tailLines: 80, follow: false })).toEqual([
    'journalctl',
    '--unit',
    'tau-api',
    '--lines',
    '80',
    '--output=cat',
    '--no-pager',
  ])
})

test('adds follow only for live journald streams', () => {
  expect(buildJournalctlArgs('tau-worker', { tailLines: 80, follow: true })).toContain('--follow')
  expect(buildJournalctlArgs('tau-worker', { tailLines: 80, follow: false })).not.toContain('--follow')
})

test('reports actionable sanitized systemd failure', async () => {
  const errors: Error[] = []
  const provider = new SystemdLogProvider(
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
  expect(errors[0].message).toContain('journal permissions')
})
