// Worker half of startUnavailableTestDb (test-db-fallback.ts): answer every
// Postgres connection with one FATAL ErrorResponse and close it.
import { postgresFatalResponse } from './test-db-fallback'

declare const self: Worker

const SSL_REQUEST = 80877103
const GSSENC_REQUEST = 80877104

self.onmessage = (event: MessageEvent<string>) => {
  const reply = postgresFatalResponse(event.data)
  const server = Bun.listen<{ pending: Buffer }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { pending: Buffer.alloc(0) }
      },
      data(socket, chunk) {
        socket.data.pending = Buffer.concat([socket.data.pending, chunk])
        while (socket.data.pending.length >= 8) {
          const length = socket.data.pending.readInt32BE(0)
          const code = socket.data.pending.readInt32BE(4)
          // Decline TLS/GSS encryption (psql and pg_dump ask first), then
          // reject whatever startup message follows.
          if (length === 8 && (code === SSL_REQUEST || code === GSSENC_REQUEST)) {
            socket.write('N')
            socket.data.pending = socket.data.pending.subarray(8)
            continue
          }
          socket.end(reply)
          return
        }
      },
      error() {},
    },
  })
  postMessage(server.port)
}
