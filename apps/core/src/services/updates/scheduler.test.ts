import { describe, expect, it } from 'bun:test'
import { LocalUpdateScheduler } from './scheduler'
import { DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS } from './types'

const LOCAL_FLAVOR = { source: 'git-checkout', supervisor: 'pm2', sandboxRuntime: 'k3d-local' } as const
const UNSUPPORTED_FLAVOR = { source: 'git-checkout', supervisor: 'unknown', sandboxRuntime: 'other' } as const

describe('LocalUpdateScheduler', () => {
  it('defines automatic updates as disabled by default', () => {
    expect(DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS.enabled).toBe(false)
  })

  it('does not schedule or apply when the enabled setting is absent', () => {
    let applied = 0
    let scheduled = 0
    const scheduler = new LocalUpdateScheduler({
      store: {
        getTyped: () => undefined,
        onChange: () => {},
      },
      updater: {
        apply: async () => {
          applied++
        },
      },
      flavor: () => LOCAL_FLAVOR,
      setIntervalFn: () => {
        scheduled++
        return 1 as any
      },
      clearIntervalFn: () => {},
    })

    scheduler.start()

    expect(scheduled).toBe(0)
    expect(applied).toBe(0)
  })

  it('starts automatic apply when enabled', async () => {
    let applied = 0
    const scheduler = new LocalUpdateScheduler({
      store: store({ enabled: true, interval: 1 }),
      updater: {
        apply: async () => {
          applied++
        },
      },
      flavor: () => LOCAL_FLAVOR,
      setIntervalFn: (fn) => {
        fn()
        return 1 as any
      },
      clearIntervalFn: () => {},
    })
    scheduler.start()
    expect(applied).toBe(1)
  })

  it('skips automatic apply when the install is not a git checkout', async () => {
    let applied = 0
    const scheduler = new LocalUpdateScheduler({
      store: store({ enabled: true, interval: 1 }),
      updater: {
        apply: async () => {
          applied++
        },
      },
      flavor: () => ({ source: 'unknown', supervisor: 'pm2', sandboxRuntime: 'k3d-local' }) as const,
      setIntervalFn: (fn) => {
        fn()
        return 1 as any
      },
      clearIntervalFn: () => {},
    })
    scheduler.start()
    expect(applied).toBe(0)
  })

  it('skips automatic apply when the deployment flavor is unsupported', async () => {
    let applied = 0
    const scheduler = new LocalUpdateScheduler({
      store: store({ enabled: true, interval: 1 }),
      updater: {
        apply: async () => {
          applied++
        },
      },
      flavor: () => UNSUPPORTED_FLAVOR,
      setIntervalFn: (fn) => {
        fn()
        return 1 as any
      },
      clearIntervalFn: () => {},
    })
    scheduler.start()
    expect(applied).toBe(0)
  })
})

function store(values: { enabled: boolean; interval: number }) {
  return {
    getTyped: (key: string) => (key === 'LOCAL_AUTO_UPDATE_ENABLED' ? values.enabled : values.interval),
    onChange: () => {},
  } as any
}
