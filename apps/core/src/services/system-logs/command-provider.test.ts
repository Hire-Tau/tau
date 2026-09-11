import { expect, test } from 'bun:test'
import { CommandLogProvider, createLinePrefixer } from './command-provider'

test('prefixes split chunks once per logical line', () => {
  const prefix = createLinePrefixer('[api] ')

  expect(prefix(Buffer.from('hel'))).toEqual(Buffer.from('[api] hel'))
  expect(prefix(Buffer.from('lo\nnext\n'))).toEqual(Buffer.from('lo\n[api] next\n'))
})

test('reports bounded stderr only to diagnostics on command failure', async () => {
  const diagnostics: unknown[] = []
  const errors: Error[] = []
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(Buffer.from(text))
        controller.close()
      },
    })
  const provider = new CommandLogProvider(
    'docker',
    () => ({ component: 'api', kind: 'container', argv: ['docker', 'logs', 'tau-api'] }),
    () => ({ stdout: stream(''), stderr: stream('daemon secret detail'), exited: Promise.resolve(1), kill() {} }),
    (_message, cause) => diagnostics.push(cause)
  )
  provider.stream(
    ['api'],
    { tailLines: 1, follow: false },
    () => {},
    (error) => errors.push(error)
  )
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(errors).toHaveLength(1)
  expect(errors[0].message).not.toContain('secret')
  expect(diagnostics).toContain('daemon secret detail')
})

test('forwards fixed argv and completes finite streams', async () => {
  const argv: string[][] = []
  let ended = 0
  const stream = new ReadableStream<Uint8Array>({ start: (c) => c.close() })
  const provider = new CommandLogProvider(
    'systemd',
    () => ({ component: 'api', kind: 'unit', argv: ['journalctl', '--unit', 'tau-api'] }),
    (args) => {
      argv.push(args)
      return { stdout: stream, stderr: null, exited: Promise.resolve(0), kill() {} }
    }
  )
  provider.stream(
    ['api'],
    { tailLines: 10, follow: false },
    () => {},
    undefined,
    () => ended++
  )
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(argv).toEqual([['journalctl', '--unit', 'tau-api']])
  expect(ended).toBe(1)
})

test('cancellation is idempotent and suppresses callbacks', async () => {
  let kills = 0
  let errors = 0
  let end = 0
  let resolveExit!: (code: number) => void
  const provider = new CommandLogProvider(
    'docker',
    () => ({ component: 'api', kind: 'container', argv: ['docker', 'logs', 'tau-api'] }),
    () => ({
      stdout: null,
      stderr: null,
      exited: new Promise((resolve) => {
        resolveExit = resolve
      }),
      kill() {
        kills++
      },
    })
  )
  const handle = provider.stream(
    ['api'],
    { tailLines: 1, follow: false },
    () => {},
    () => errors++,
    () => end++
  )
  await Bun.sleep(0)
  handle.cancel()
  handle.cancel()
  resolveExit(1)
  await Bun.sleep(0)
  expect(kills).toBe(1)
  expect(errors).toBe(0)
  expect(end).toBe(0)
})

test('drains large stderr while bounding diagnostic capture', async () => {
  const diagnostics: string[] = []
  const errors: Error[] = []
  let pulls = 0
  const stderr = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      if (pulls <= 10) controller.enqueue(Buffer.alloc(1024, 120))
      else controller.close()
    },
  })
  const provider = new CommandLogProvider(
    'docker',
    () => ({ component: 'api', kind: 'container', argv: ['docker'] }),
    () => ({ stdout: null, stderr, exited: Promise.resolve(1), kill() {} }),
    (_message, cause) => diagnostics.push(String(cause)),
    'Unable to read configured Docker logs; check daemon access and container names.'
  )
  provider.stream(
    ['api'],
    { tailLines: 1, follow: false },
    () => {},
    (error) => errors.push(error)
  )
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(pulls).toBe(11)
  expect(diagnostics[0]).toHaveLength(4096)
  expect((errors[0] as { code?: string }).code).toBe('STREAM_FAILED')
  expect(errors[0].message).toContain('Docker')
  expect(errors[0].message).not.toContain('xxx')
})
