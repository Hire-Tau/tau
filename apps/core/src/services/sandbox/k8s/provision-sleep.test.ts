import { describe, expect, test } from 'bun:test'
import { getEventListeners } from 'events'
import { defaultProvisionSleep } from './provision-coordinator'
import { abortableManagerSleep } from './manager'
import { abortablePodSleep } from './pod-manager'

describe('abort-aware provisioning sleeps', () => {
  test.each([
    ['coordinator', defaultProvisionSleep],
    ['manager', abortableManagerSleep],
    ['pod manager', abortablePodSleep],
  ] as const)('%s removes listeners after every successful poll', async (_name, sleep) => {
    const controller = new AbortController()
    for (let index = 0; index < 100; index++) {
      await sleep(0, controller.signal)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    }
  })
})
