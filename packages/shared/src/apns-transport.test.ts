import { expect, test } from 'bun:test'
import * as http2 from 'node:http2'
import { apnsHttp2Request } from './apns'

async function fixture(onStream: (stream: http2.ServerHttp2Stream) => void) {
  const sessions = new Set<http2.ServerHttp2Session>()
  const server = http2.createServer()
  server.on('session', (session) => {
    sessions.add(session)
    session.on('error', () => {})
    session.on('close', () => sessions.delete(session))
  })
  server.on('stream', (stream) => {
    stream.on('error', () => {})
    onStream(stream as http2.ServerHttp2Stream)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return {
    host: `http://127.0.0.1:${address.port}`,
    sessions,
    async stop() {
      for (const session of sessions) session.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
test('APNs timeout destroys the session even when the server never ends its response', async () => {
  let closed!: () => void
  const close = new Promise<void>((resolve) => {
    closed = resolve
  })
  const f = await fixture((stream) => {
    stream.on('close', closed)
    stream.respond({ ':status': 200 })
    stream.write('partial')
  })
  try {
    await expect(
      apnsHttp2Request({ host: f.host, path: '/push', headers: {}, body: '{}' }, { timeoutMs: 100 })
    ).rejects.toThrow('timed out')
    await close
  } finally {
    await f.stop()
  }
})
test('APNs response bodies are bounded before buffering arbitrary provider data', async () => {
  const f = await fixture((stream) => {
    stream.respond({ ':status': 500 })
    stream.end('x'.repeat(9000))
  })
  try {
    await expect(apnsHttp2Request({ host: f.host, path: '/push', headers: {}, body: '{}' })).rejects.toThrow(
      'size limit'
    )
  } finally {
    await f.stop()
  }
})
