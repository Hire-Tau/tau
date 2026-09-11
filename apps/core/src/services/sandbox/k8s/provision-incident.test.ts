import { afterAll as maintenanceAfterAll, beforeAll as maintenanceBeforeAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../../../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
maintenanceBeforeAll(async () => (releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()))
maintenanceAfterAll(() => releaseMaintenanceIsolation?.())

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { db } from '../../../db'
import { eq } from 'drizzle-orm'
import { k8sProvisionAttempts, k8sProvisionControls } from '../../../db/schema'
import { ProvisionCoordinator } from './provision-coordinator'
import { DEFAULT_PROVISION_CONFIG } from './provision-config'
import { K8sPodManager } from './pod-manager'
import { PostgresProvisionStore } from './provision-store'

let scope: string
const config = { ...DEFAULT_PROVISION_CONFIG, maxConcurrent: 4, maxWaiters: 32 }
beforeEach(() => {
  scope = crypto.randomUUID()
})
afterEach(async () => {
  await db.delete(k8sProvisionAttempts).where(eq(k8sProvisionAttempts.scope, scope))
  await db.delete(k8sProvisionControls).where(eq(k8sProvisionControls.scope, scope))
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

describe('Kubernetes provisioning incident bounds', () => {
  test('100 same-sandbox callers execute one owner operation and bound waiters', async () => {
    const store = new PostgresProvisionStore({ db, config })
    const coordinator = new ProvisionCoordinator({ store, config, ownerId: 'api' })
    const held = deferred<string>()
    let operations = 0
    const calls = Array.from({ length: 100 }, () =>
      coordinator.run({
        scope,
        sandboxKey: 'box',
        operationKind: 'ensure',
        desiredSpecHash: 'spec',
        provision: async () => {
          operations++
          return { podName: await held.promise, resultSpecHash: 'spec' }
        },
        attach: async (podName) => podName,
      })
    )
    held.resolve('pod')
    const results = await Promise.allSettled(calls)
    expect(operations).toBe(1)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(32)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(68)
    expect(coordinator.getLocalDiagnostics()).toMatchObject({ localOperations: 0, localWaiters: 0 })
    await coordinator.shutdown()
  })

  test('real pod readiness classification opens the durable breaker', async () => {
    const store = new PostgresProvisionStore({ db, config: { ...config, failureThreshold: 3 } })
    const coordinator = new ProvisionCoordinator({ store, config: { ...config, failureThreshold: 3 }, ownerId: 'api' })
    for (const sandboxKey of ['unsched-a', 'unsched-b', 'unsched-c']) {
      let now = 0
      const podManager = {
        namespace: 'tau-sandboxes',
        coreApi: {
          readNamespacedPod: async () => ({
            status: { phase: 'Pending' },
          }),
        },
        sleep: async () => {
          now += 10
        },
        now: () => now,
      }
      await expect(
        coordinator.run({
          scope,
          sandboxKey,
          operationKind: 'ensure',
          desiredSpecHash: 'spec',
          provision: async () => {
            await (K8sPodManager.prototype as any).waitForPodReady.call(podManager, `pod-${sandboxKey}`, 10)
            return { podName: `pod-${sandboxKey}`, resultSpecHash: 'spec' }
          },
          attach: async (podName) => podName,
        })
      ).rejects.toMatchObject({ code: 'SANDBOX_PROVISION_FAILED' })
    }
    expect(await store.diagnostics(scope)).toMatchObject({ state: 'open', reasonCode: 'unschedulable_capacity' })
    await coordinator.shutdown()
  })

  test('repeated Running executor timeouts remain sandbox-specific and keep the breaker closed', async () => {
    const store = new PostgresProvisionStore({ db, config: { ...config, failureThreshold: 3 } })
    const coordinator = new ProvisionCoordinator({ store, config: { ...config, failureThreshold: 3 }, ownerId: 'api' })
    for (const sandboxKey of ['executor-a', 'executor-b', 'executor-c']) {
      let now = 0
      const podManager = {
        namespace: 'tau-sandboxes',
        coreApi: { readNamespacedPod: async () => ({ status: { phase: 'Running' } }) },
        sleep: async () => {
          now += 10
        },
        now: () => now,
      }
      await expect(
        coordinator.run({
          scope,
          sandboxKey,
          operationKind: 'ensure',
          desiredSpecHash: 'spec',
          provision: async () => {
            await (K8sPodManager.prototype as any).waitForPodReady.call(podManager, `pod-${sandboxKey}`, 10)
            return { podName: `pod-${sandboxKey}`, resultSpecHash: 'spec' }
          },
          attach: async (podName) => podName,
        })
      ).rejects.toMatchObject({ code: 'SANDBOX_PROVISION_FAILED' })
    }
    expect(await store.diagnostics(scope)).toMatchObject({ state: 'closed', recentFailureCount: 0 })
    await coordinator.shutdown()
  })

  // A bad sandbox-image release on a HEALTHY cluster must not open the cluster breaker.
  test('a broken sandbox image across many sandboxes leaves the breaker closed', async () => {
    const thresholdConfig = { ...config, failureThreshold: 3 }
    const store = new PostgresProvisionStore({ db, config: thresholdConfig })
    const coordinator = new ProvisionCoordinator({ store, config: thresholdConfig, ownerId: 'api' })
    for (const sandboxKey of ['image-a', 'image-b', 'image-c']) {
      let now = 0
      const podManager = {
        namespace: 'tau-sandboxes',
        coreApi: {
          readNamespacedPod: async () => ({
            status: {
              phase: 'Pending',
              conditions: [{ type: 'PodScheduled', status: 'True' }],
              containerStatuses: [{ name: 'sandbox', state: { waiting: { reason: 'InvalidImageName' } } }],
            },
          }),
        },
        sleep: async (ms: number) => {
          now += ms
        },
        now: () => now,
      }
      await expect(
        coordinator.run({
          scope,
          sandboxKey,
          operationKind: 'ensure',
          desiredSpecHash: 'spec',
          provision: async () => {
            await (K8sPodManager.prototype as any).waitForPodReady.call(podManager, `pod-${sandboxKey}`, 5_000)
            return { podName: `pod-${sandboxKey}`, resultSpecHash: 'spec' }
          },
          attach: async (podName) => podName,
        })
      ).rejects.toMatchObject({ code: 'SANDBOX_PROVISION_FAILED' })
    }
    expect(await store.diagnostics(scope)).toMatchObject({ state: 'closed', recentFailureCount: 0 })
    await coordinator.shutdown()
  })

  test('two coordinators emit one authoritative threshold transition, not one per observer', async () => {
    const thresholdConfig = { ...config, failureThreshold: 2 }
    const store = new PostgresProvisionStore({ db, config: thresholdConfig })
    const events: unknown[][] = [[], []]
    const coordinators = ['api', 'worker'].map(
      (ownerId, index) =>
        new ProvisionCoordinator({
          store,
          config: thresholdConfig,
          ownerId,
          onTransition: (event) => events[index]!.push(event),
        })
    )
    for (let index = 0; index < 2; index++) {
      await expect(
        coordinators[index]!.run({
          scope,
          sandboxKey: `failure-${index}`,
          operationKind: 'ensure',
          desiredSpecHash: 'spec',
          provision: async () => {
            // A REAL API-server outage: Bun's fetch reports `code: 'ConnectionRefused'`,
            // never Node's `ECONNREFUSED`. Throwing the synthetic Node shape here kept
            // this test green even while the classifier matched nothing in production.
            await fetch('http://127.0.0.1:1')
            throw new Error('expected the connection to be refused')
          },
          attach: async (podName) => podName,
        })
      ).rejects.toMatchObject({ code: 'SANDBOX_PROVISION_FAILED' })
    }
    await expect(
      coordinators[0]!.run({
        scope,
        sandboxKey: 'observer',
        operationKind: 'ensure',
        desiredSpecHash: 'spec',
        provision: async () => ({ podName: 'never', resultSpecHash: 'spec' }),
        attach: async (podName) => podName,
      })
    ).rejects.toMatchObject({ code: 'SANDBOX_PROVISION_UNAVAILABLE' })
    expect(events.flat()).toEqual([
      {
        from: 'closed',
        to: 'open',
        version: 1,
        reasonCode: 'control_plane_unavailable',
        retryAfterMs: thresholdConfig.cooldownMs,
        inFlight: 0,
      },
    ])
    await Promise.all(coordinators.map((coordinator) => coordinator.shutdown()))
  })

  test('100 different sandboxes admit no more than the shared cap', async () => {
    const store = new PostgresProvisionStore({ db, config })
    const coordinators = ['api', 'worker'].map((ownerId) => new ProvisionCoordinator({ store, config, ownerId }))
    const held = deferred<string>()
    let operations = 0
    const calls = Array.from({ length: 100 }, (_, index) =>
      coordinators[index % 2]!.run({
        scope,
        sandboxKey: `box-${index}`,
        operationKind: 'ensure',
        desiredSpecHash: 'spec',
        provision: async () => {
          operations++
          return { podName: await held.promise, resultSpecHash: 'spec' }
        },
        attach: async (podName) => podName,
      })
    )
    const settled = Promise.allSettled(calls)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(operations).toBeLessThanOrEqual(4)
    held.resolve('pod')
    await settled
    expect(
      (await db.select().from(k8sProvisionAttempts).where(eq(k8sProvisionAttempts.scope, scope))).length
    ).toBeLessThanOrEqual(128)
    await Promise.all(coordinators.map((coordinator) => coordinator.shutdown()))
  }, 15_000)
})
