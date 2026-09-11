import { describe, expect, it } from 'bun:test'
import { instanceNames } from './instance'
import { parseJlist, pm2Args, runPm2 } from './pm2'
import { recordingRunner } from './runner'

const tau = instanceNames('tau')
const smoke = instanceNames('smoke')

describe('pm2Args', () => {
  it('builds the ecosystem-scoped start and the named stop/restart', () => {
    expect(pm2Args('start', tau)).toEqual([
      'start',
      'ecosystem.config.js',
      '--only',
      'tau-api,tau-worker',
      '--update-env',
    ])
    expect(pm2Args('stop', tau)).toEqual(['stop', 'tau-api', 'tau-worker'])
    expect(pm2Args('restart', tau)).toEqual(['restart', 'tau-api', 'tau-worker', '--update-env'])
    expect(pm2Args('delete', tau)).toEqual(['delete', 'tau-api', 'tau-worker'])
    expect(pm2Args('logs', tau, ['tau-api', '--lines', '50', '--nostream'])).toEqual([
      'logs',
      'tau-api',
      '--lines',
      '50',
      '--nostream',
    ])
  })
  it('addresses the instance apps for a labelled instance', () => {
    expect(pm2Args('start', smoke)).toEqual([
      'start',
      'ecosystem.config.js',
      '--only',
      'tau-smoke-api,tau-smoke-worker',
      '--update-env',
    ])
    expect(pm2Args('stop', smoke)).toEqual(['stop', 'tau-smoke-api', 'tau-smoke-worker'])
    expect(pm2Args('restart', smoke)).toEqual(['restart', 'tau-smoke-api', 'tau-smoke-worker', '--update-env'])
    expect(pm2Args('delete', smoke)).toEqual(['delete', 'tau-smoke-api', 'tau-smoke-worker'])
  })
})

describe('parseJlist', () => {
  it('extracts name, status, pid and cwd, ignoring unrelated apps', () => {
    const json = JSON.stringify([
      { name: 'tau-api', pid: 11, pm2_env: { status: 'online', pm_cwd: '/r' } },
      { name: 'other', pid: 12, pm2_env: { status: 'online', pm_cwd: '/o' } },
      { name: 'tau-worker', pid: 0, pm2_env: { status: 'stopped', pm_cwd: '/r' } },
    ])
    expect(parseJlist(json, tau)).toEqual([
      { name: 'tau-api', status: 'online', pid: 11, cwd: '/r' },
      { name: 'tau-worker', status: 'stopped', pid: 0, cwd: '/r' },
    ])
  })
  it('skips the [PM2] banner lines pm2 prints before the JSON on its first daemon start', () => {
    const banner = '[PM2] Spawning PM2 daemon with pm2_home=/root/.pm2\n[PM2] PM2 Successfully daemonized\n'
    const json = JSON.stringify([{ name: 'tau-api', pid: 11, pm2_env: { status: 'online', pm_cwd: '/r' } }])
    expect(parseJlist(banner + json, tau)).toEqual([{ name: 'tau-api', status: 'online', pid: 11, cwd: '/r' }])
  })
  it('finds the array when a bracket also appears inside a banner message and inside JSON strings', () => {
    const noisy =
      '[PM2] Spawning PM2 daemon [pid 123] with pm2_home=/root/.pm2\n' +
      JSON.stringify([{ name: 'tau-api', pid: 1, pm2_env: { status: 'online', pm_cwd: '/r [x]' } }])
    expect(parseJlist(noisy, tau).map((p) => p.name)).toEqual(['tau-api'])
  })
  it('returns [] for garbage', () => {
    expect(parseJlist('not json', tau)).toEqual([])
  })
  it('keeps another instance apps out of the default instance view, and vice versa', () => {
    const json = JSON.stringify([
      { name: 'tau-api', pid: 11, pm2_env: { status: 'online', pm_cwd: '/r' } },
      { name: 'tau-smoke-api', pid: 21, pm2_env: { status: 'online', pm_cwd: '/s' } },
      { name: 'tau-smoke-worker', pid: 22, pm2_env: { status: 'online', pm_cwd: '/s' } },
    ])
    expect(parseJlist(json, tau)).toEqual([{ name: 'tau-api', status: 'online', pid: 11, cwd: '/r' }])
    expect(parseJlist(json, smoke)).toEqual([
      { name: 'tau-smoke-api', status: 'online', pid: 21, cwd: '/s' },
      { name: 'tau-smoke-worker', status: 'online', pid: 22, cwd: '/s' },
    ])
  })
})

describe('runPm2', () => {
  it('invokes bunx pm2 from the root', async () => {
    const rec = recordingRunner()
    await runPm2(rec.runner, '/root', pm2Args('save', tau))
    expect(rec.calls[0].command).toEqual(['bunx', 'pm2', 'save'])
    expect(rec.calls[0].options.cwd).toBe('/root')
  })
})
