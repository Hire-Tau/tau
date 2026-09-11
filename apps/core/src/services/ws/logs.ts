/**
 * Sandbox Logs WebSocket Handler
 *
 * Read-only live-tail of a sandbox's container logs at
 * /ws/sandbox/:sandboxId/logs. Binary frames carry log chunks; JSON frames
 * carry control messages ({ type: 'info' | 'error', message }). Does NOT
 * create or recreate the sandbox — it streams from the existing pod/container.
 */

import type { ServerWebSocket } from 'bun'
import type { Context } from 'hono'
import type { WSEvents } from 'hono/ws'
import { getSandboxManager } from '../sandbox/factory'
import { getSquadIdFromSandbox } from '../sandbox/types'
import { Squad } from '../../entities/Squad'
import { createLogger } from '../../lib/infra/logger'
import { resourceDiagnostics, type ResourceLease, type ResourceOutcome } from '../../lib/infra/resource-diagnostics'

const log = createLogger('sandbox-logs-ws')

const DEFAULT_TAIL_LINES = 500
const MAX_TAIL_LINES = 5000

export interface LogsParams {
  sandboxId: string
  tailLines: number
  previous: boolean
}

export function getLogsParams(c: Context): LogsParams | null {
  const sandboxId = c.req.param('sandboxId')
  if (!sandboxId) return null
  const url = new URL(c.req.url)
  const tailRaw = Number.parseInt(url.searchParams.get('tailLines') ?? '', 10)
  const tailLines = Number.isFinite(tailRaw) ? Math.min(Math.max(tailRaw, 1), MAX_TAIL_LINES) : DEFAULT_TAIL_LINES
  const previous = url.searchParams.get('previous') === 'true'
  return { sandboxId, tailLines, previous }
}

function sendControl(ws: { raw?: ServerWebSocket }, type: 'info' | 'error', message: string): void {
  ws.raw?.send(JSON.stringify({ type, message }))
}

interface LogsWebSocketDeps {
  findSquad: (id: string) => Promise<unknown | null>
  getManager: () => Pick<ReturnType<typeof getSandboxManager>, 'streamLogs'>
}

const defaultDeps: LogsWebSocketDeps = { findSquad: (id) => Squad.find(id), getManager: getSandboxManager }

export function createLogsWebSocketHandlers(
  params: LogsParams,
  deps: LogsWebSocketDeps = defaultDeps
): WSEvents<ServerWebSocket> {
  let stream: { cancel: () => void } | null = null
  let lease: ResourceLease | null = null
  let closed = false

  const finalize = (outcome: ResourceOutcome): void => {
    if (closed) return
    closed = true
    stream?.cancel()
    stream = null
    lease?.finish(outcome)
    lease = null
  }

  return {
    async onOpen(_event, ws) {
      if (!ws.raw) return
      try {
        const squadId = getSquadIdFromSandbox(params.sandboxId)
        if (!squadId) {
          ws.raw.close(4004, 'Unknown sandbox type')
          return
        }
        const squad = await deps.findSquad(squadId)
        if (closed) return
        if (!squad) {
          ws.raw.close(4004, 'Squad not found')
          return
        }

        const manager = deps.getManager()
        // Capability gate: runtimes without a container-log stream (the vm
        // runtime — boxes surface output via exec/streamExec) simply do not
        // implement the optional streamLogs, so the socket closes with a clear
        // "not supported" instead of holding a silent, forever-empty stream.
        if (!manager.streamLogs) {
          sendControl(ws, 'error', 'Log streaming is not supported for this runtime')
          ws.raw.close(4000, 'Log streaming not supported')
          return
        }

        const started = manager.streamLogs(
          params.sandboxId,
          { tailLines: params.tailLines, follow: true, previous: params.previous },
          (chunk) => ws.raw?.send(chunk),
          (err) => {
            sendControl(ws, 'error', err.message)
            finalize('failed')
            ws.raw?.close(4500, 'Log stream failed')
          }
        )
        if (closed) started.cancel()
        else {
          stream = started
          lease = resourceDiagnostics.begin('sandbox_log_stream')
        }
      } catch (err) {
        if (closed) return
        log.error(`Failed to start log stream for ${params.sandboxId}:`, err)
        sendControl(ws, 'error', 'Failed to start log stream')
        ws.raw.close(4500, 'Failed to start log stream')
      }
    },
    onMessage() {},
    onClose() {
      finalize('cancelled')
    },
    onError() {
      finalize('failed')
    },
  }
}
