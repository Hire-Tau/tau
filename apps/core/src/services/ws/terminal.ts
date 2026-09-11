/**
 * Terminal WebSocket Handler
 *
 * WebSocket endpoint for terminal I/O at /ws/terminal.
 * Handles binary frames for terminal data and JSON frames for control messages.
 * Sandbox IDs for squads are formatted as 'squad_<uuid>'.
 */

import type { ServerWebSocket } from 'bun'
import type { Context } from 'hono'
import { terminalManager } from '../sandbox/docker/terminal'
import { getSquadIdFromSandbox } from '../sandbox/types'
import { ensureSquadSandbox } from '../sandbox/ensure'
import { WSEvents } from 'hono/ws'
import { Squad } from '../../entities/Squad'
import { createLogger } from '../../lib/infra/logger'
import { SandboxProvisionError } from '../sandbox/k8s/provision-errors'

const log = createLogger('terminal')

export function getProvisioningWebSocketClose(error: unknown): { code: 1013; reason: string } | null {
  if (!(error instanceof SandboxProvisionError)) return null
  const retry = error.retryAfterMs == null ? '' : ` Retry in ${Math.ceil(error.retryAfterMs / 1_000)}s.`
  return { code: 1013, reason: `Sandbox temporarily unavailable.${retry}`.slice(0, 123) }
}

// Track session ID for each WebSocket connection
const wsSessionMap = new WeakMap<ServerWebSocket, string>()

interface ResizeMessage {
  type: 'resize'
  cols: number
  rows: number
}

function isResizeMessage(data: unknown): data is ResizeMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as ResizeMessage).type === 'resize' &&
    typeof (data as ResizeMessage).cols === 'number' &&
    typeof (data as ResizeMessage).rows === 'number'
  )
}

/**
 * Create WebSocket handlers for terminal connections.
 */
export function createTerminalWebSocketHandlers(
  sandboxId: string,
  sessionId: string | null
): WSEvents<ServerWebSocket> {
  return {
    async onOpen(_event, ws) {
      if (!ws.raw) return

      try {
        // Ensure sandbox exists — lazily create if not yet running
        // Always try to ensure sandbox (handles deleted containers, restarts, etc.)
        let workspacePath: string | undefined
        const squadId = getSquadIdFromSandbox(sandboxId)
        try {
          if (squadId) {
            log.info(`Ensuring squad sandbox for terminal: ${sandboxId}`)
            const squad = await Squad.find(squadId)
            if (!squad) {
              log.error(`Squad not found: ${squadId}`)
              ws.raw.close(4004, 'Squad not found')
              return
            }
            workspacePath = await ensureSquadSandbox(squad)
          } else {
            log.error(`Unknown sandbox type: ${sandboxId}`)
            ws.raw.close(4004, 'Unknown sandbox type')
            return
          }
        } catch (error) {
          const provisioningClose = getProvisioningWebSocketClose(error)
          if (provisioningClose) {
            ws.raw.close(provisioningClose.code, provisioningClose.reason)
            return
          }
          log.error(`Failed to ensure sandbox ${sandboxId}:`, error)
          ws.raw.close(4004, 'Failed to create sandbox')
          return
        }

        let session
        if (sessionId) {
          // Reattach to existing session
          session = terminalManager.getSession(sessionId)
          if (!session) {
            ws.raw.close(4004, 'Session not found')
            return
          }
          if (session.sandboxId !== sandboxId) {
            ws.raw.close(4003, 'Session does not belong to this sandbox')
            return
          }
        } else {
          // Create new session with workspacePath for devbox activation
          session = await terminalManager.createSession(sandboxId, 80, 24, workspacePath)
        }

        // Track the session for this WebSocket
        wsSessionMap.set(ws.raw, session.sessionId)

        // Attach client to session
        terminalManager.attachClient(session.sessionId, ws.raw)
      } catch (error) {
        log.error('Error in terminal WebSocket onOpen:', error)
        ws.raw.close(4500, 'Internal server error')
      }
    },

    onMessage(event, ws) {
      if (!ws.raw) return

      const sessionId = wsSessionMap.get(ws.raw)
      if (!sessionId) return

      const data = event.data

      // Binary data: forward to PTY
      if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
        const buffer = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer)
        terminalManager.write(sessionId, buffer)
        return
      }

      // String data: could be binary-as-string or JSON control message
      if (typeof data === 'string') {
        // Try to parse as JSON control message
        try {
          const parsed = JSON.parse(data)
          if (isResizeMessage(parsed)) {
            terminalManager.resize(sessionId, parsed.cols, parsed.rows)
            return
          }
        } catch {
          // Not JSON, treat as terminal input
        }

        // Forward as terminal input
        terminalManager.write(sessionId, data)
      }
    },

    onClose(_event, ws) {
      if (!ws.raw) return
      const sessionId = wsSessionMap.get(ws.raw)
      if (sessionId) {
        terminalManager.detachClient(sessionId, ws.raw)
        wsSessionMap.delete(ws.raw)
      }
    },

    onError(event, ws) {
      if (!ws.raw) return
      log.error('Terminal WebSocket error:', event)
      const sessionId = wsSessionMap.get(ws.raw)
      if (sessionId) {
        terminalManager.detachClient(sessionId, ws.raw)
        wsSessionMap.delete(ws.raw)
      }
    },
  }
}

/**
 * Extract terminal WebSocket parameters from the request context.
 * Accepts sandboxId directly, or taskId/squadId for convenience (converted to sandbox ID).
 */
export function getTerminalParams(c: Context): { sandboxId: string; sessionId: string | null } | null {
  const url = new URL(c.req.url)
  const sessionId = url.searchParams.get('sessionId')

  // Direct sandbox ID (preferred)
  const sandboxId = url.searchParams.get('sandboxId')
  if (sandboxId) {
    return { sandboxId, sessionId }
  }

  // squadId → squad_<squadId>
  const squadId = url.searchParams.get('squadId')
  if (squadId) {
    return { sandboxId: Squad.getSandboxId(squadId), sessionId }
  }

  return null
}
