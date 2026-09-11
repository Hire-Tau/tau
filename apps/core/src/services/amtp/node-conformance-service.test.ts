import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeServiceOwner } from './node-conformance-service'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs.length = 0
})

function reservePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('reserved') })
  const port = server.port!
  server.stop(true)
  return port
}

test('releases a bound port when listening is never published', async () => {
  const captureDir = await mkdtemp(join(tmpdir(), 'amtp-service-owner-'))
  dirs.push(captureDir)
  const port = reservePort()
  const owner = new NodeServiceOwner(captureDir)

  await expect(
    owner.startCandidate(
      [
        'bun',
        '-e',
        `const server=Bun.serve({port:${port},fetch:()=>new Response('ok')}); console.error(JSON.stringify({kind:'bind:done',port:server.port})); setInterval(()=>{},1000)`,
      ],
      { timeoutMs: 100, match: () => false }
    )
  ).rejects.toMatchObject({ code: 'SUBPROCESS_PHASE_FAILED', phase: 'node-listening-record' })

  expect(owner.snapshot()).toEqual({ generation: 0, active: false })
  expect(await readdir(captureDir)).toEqual([])
  const replacement = Bun.serve({ port, fetch: () => new Response('reused') })
  expect(replacement.port).toBe(port)
  replacement.stop(true)
})

test('stop cancels an in-flight candidate before it can publish', async () => {
  const captureDir = await mkdtemp(join(tmpdir(), 'amtp-service-owner-'))
  dirs.push(captureDir)
  const port = reservePort()
  const owner = new NodeServiceOwner(captureDir)
  const start = owner.startCandidate(
    [
      'bun',
      '-e',
      `const server=Bun.serve({port:${port},fetch:()=>new Response('ok')}); setTimeout(()=>console.log(JSON.stringify({listening:true,port:server.port,instanceId:'node'})),1000); setInterval(()=>{},1000)`,
    ],
    { timeoutMs: 2_000, match: (value) => (value as { listening?: boolean }).listening === true }
  )
  await Bun.sleep(25)
  await owner.stop()
  await expect(start).rejects.toMatchObject({ code: 'SUBPROCESS_PHASE_CANCELLED' })
  expect(owner.snapshot()).toEqual({ generation: 0, active: false })
  expect(await readdir(captureDir)).toEqual([])
  const replacement = Bun.serve({ port, fetch: () => new Response('reused') })
  replacement.stop(true)
})

test('single-flights concurrent candidate startup and publishes once', async () => {
  const captureDir = await mkdtemp(join(tmpdir(), 'amtp-service-owner-'))
  dirs.push(captureDir)
  const port = reservePort()
  const owner = new NodeServiceOwner(captureDir)
  const command = [
    'bun',
    '-e',
    `const server=Bun.serve({port:${port},fetch:()=>new Response('ok')}); console.log(JSON.stringify({listening:true,port:server.port,instanceId:'node'})); setInterval(()=>{},1000)`,
  ]
  const options = {
    timeoutMs: 2_000,
    match: (value: unknown) => (value as { listening?: boolean }).listening === true,
  }

  const [a, b] = await Promise.all([owner.startCandidate(command, options), owner.startCandidate(command, options)])
  expect(a).toEqual(b)
  expect(a).toMatchObject({ generation: 1, port })
  await owner.stop()
  expect(await readdir(captureDir)).toEqual([])
})
