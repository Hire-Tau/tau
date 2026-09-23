import { afterEach, describe, expect, test } from 'bun:test'
import { desktopInstance } from './desktop'

afterEach(() => {
  delete window.tauDesktopApp
})

describe('desktopInstance', () => {
  test('returns undefined without a bridge', () => {
    expect(desktopInstance()).toBeUndefined()
  })

  test('returns undefined when instance.kind is not one of the three kinds', () => {
    window.tauDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      // @ts-expect-error exercising an invalid kind from an untrusted/older bridge
      instance: { kind: 'bogus', name: 'noah' },
    }

    expect(desktopInstance()).toBeUndefined()
  })

  test('returns undefined when name is not a string', () => {
    window.tauDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      // @ts-expect-error exercising a malformed name from an untrusted/older bridge
      instance: { kind: 'local', name: 42 },
    }

    expect(desktopInstance()).toBeUndefined()
  })

  test('returns the instance when kind and name are valid', () => {
    const instance = { kind: 'remote' as const, name: 'noah' }
    window.tauDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      instance,
    }

    expect(desktopInstance()).toBe(instance)
  })
})
