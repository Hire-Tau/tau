import { expect, test } from 'bun:test'
import type { Writable } from 'node:stream'
import { K8sLogProvider, type K8sLogDependencies } from './k8s-provider'
import { SystemLogProviderError } from './types'

const config = {
  namespace: 'tau-core',
  selectors: { api: 'component=api', worker: 'component=worker' },
  containers: { api: 'tau-api', worker: 'tau-worker' },
}
const pod = (name: string, container = 'tau-api') => ({
  metadata: { name },
  spec: { containers: [{ name: container }] },
})
const tick = async () => {
  await Bun.sleep(0)
  await Bun.sleep(0)
}

test('sorts replicas and attributes split lines with pod and container', async () => {
  const output: string[] = []
  const opened: string[] = []
  const dependencies: K8sLogDependencies = {
    listPods: async () => [pod('api-b'), pod('api-a')],
    openLog: async (_namespace, name, _container, writable) => {
      opened.push(name)
      writable.write(Buffer.from('hel'))
      writable.write(Buffer.from('lo\n'))
      writable.end()
      return new AbortController()
    },
  }
  new K8sLogProvider(config, dependencies).stream(['api'], { tailLines: 10, follow: false }, (chunk) =>
    output.push(chunk.toString())
  )
  await tick()
  expect(opened).toEqual(['api-a', 'api-b'])
  expect(output.join('')).toContain('[api pod/api-a container/tau-api] hello\n')
})

test('maps missing pods and forbidden discovery to stable typed errors', async () => {
  const errors: Error[] = []
  const provider = new K8sLogProvider(config, {
    listPods: async () => [],
    openLog: async () => new AbortController(),
    reportDiagnostic() {},
  })
  provider.stream(
    ['api'],
    { tailLines: 1, follow: false },
    () => {},
    (error) => errors.push(error)
  )
  await tick()
  expect(errors[0]).toBeInstanceOf(SystemLogProviderError)
  expect((errors[0] as SystemLogProviderError).code).toBe('TARGET_NOT_FOUND')

  errors.length = 0
  new K8sLogProvider(config, {
    listPods: async () => {
      throw { response: { statusCode: 403 }, secret: 'raw' }
    },
    openLog: async () => new AbortController(),
    reportDiagnostic() {},
  }).stream(
    ['api'],
    { tailLines: 1, follow: false },
    () => {},
    (error) => errors.push(error)
  )
  await tick()
  expect((errors[0] as SystemLogProviderError).code).toBe('ACCESS_DENIED')
  expect(errors[0].message).not.toContain('raw')
})

test('maps dependency bootstrap failure without throwing synchronously', async () => {
  const errors: Error[] = []
  const provider = new K8sLogProvider(config, undefined, () => {
    throw new Error('kube bootstrap secret')
  })
  expect(() =>
    provider.stream(
      ['api'],
      { tailLines: 1, follow: false },
      () => {},
      (error) => errors.push(error)
    )
  ).not.toThrow()
  await tick()
  expect((errors[0] as SystemLogProviderError).code).toBe('STREAM_FAILED')
  expect(errors[0].message).not.toContain('secret')
})

test('fails a writable stream once and aborts its controller', async () => {
  const errors: Error[] = []
  let ended = 0
  const controller = new AbortController()
  const provider = new K8sLogProvider(config, {
    listPods: async () => [pod('api-a')],
    openLog: async (_namespace, _pod, _container, writable) => {
      queueMicrotask(() => {
        writable.emit('error', new Error('raw stream detail'))
        writable.emit('error', new Error('duplicate'))
      })
      return controller
    },
    reportDiagnostic() {},
  })
  provider.stream(
    ['api'],
    { tailLines: 1, follow: true },
    () => {},
    (error) => errors.push(error),
    () => ended++
  )
  await tick()
  expect((errors[0] as SystemLogProviderError).code).toBe('STREAM_FAILED')
  expect(errors).toHaveLength(1)
  expect(ended).toBe(0)
  expect(controller.signal.aborted).toBe(true)
})

test('aborts a controller returned after cancellation and suppresses late data', async () => {
  let resolveController!: (controller: AbortController) => void
  const controller = new AbortController()
  let writable!: Writable
  let chunks = 0
  const provider = new K8sLogProvider(config, {
    listPods: async () => [pod('api-a')],
    openLog: async (_namespace, _pod, _container, target) => {
      writable = target
      return new Promise((resolve) => {
        resolveController = resolve
      })
    },
    reportDiagnostic() {},
  })
  const handle = provider.stream(['api'], { tailLines: 1, follow: true }, () => chunks++)
  await tick()
  handle.cancel()
  writable.write(Buffer.from('late\n'))
  resolveController(controller)
  await tick()
  expect(chunks).toBe(0)
  expect(controller.signal.aborted).toBe(true)
})
