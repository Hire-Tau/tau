/**
 * Terminal Manager Tests
 *
 * Tests for the terminal session management service.
 * Note: Tests that require actual PTY spawning are not included here
 * since bun-pty requires a real terminal environment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { terminalManager } from './terminal'

describe('terminal-manager', () => {
  let testWorkspace: string

  beforeEach(() => {
    testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-test-'))
  })

  afterEach(() => {
    terminalManager.cleanup()

    if (testWorkspace && fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true })
    }
  })

  describe('listSessions', () => {
    it('should return empty array for sandbox with no sessions', () => {
      const sessions = terminalManager.listSessions('nonexistent-sandbox')
      expect(sessions).toEqual([])
    })
  })

  describe('getSession', () => {
    it('should return undefined for non-existent session', () => {
      const session = terminalManager.getSession('nonexistent-session')
      expect(session).toBeUndefined()
    })
  })

  describe('killSandboxSessions', () => {
    it('should handle sandbox with no sessions', () => {
      expect(() => {
        terminalManager.killSandboxSessions('nonexistent-sandbox')
      }).not.toThrow()
    })
  })

  describe('cleanup', () => {
    it('should not throw when called with no sessions', () => {
      expect(() => {
        terminalManager.cleanup()
      }).not.toThrow()
    })
  })
})

describe('terminal-manager utilities', () => {
  it('should have a singleton instance', async () => {
    const { terminalManager: tm1 } = await import('./terminal')
    const { terminalManager: tm2 } = await import('./terminal')
    expect(tm1).toBe(tm2)
  })
})

describe('createSession sandbox ensure', () => {
  interface FakeManagerCalls {
    ensured: Array<{ sandboxId: string; opts: unknown }>
    spawned: string[]
  }

  function makeFakePty() {
    return {
      pid: 1,
      process: 'bash',
      cols: 80,
      rows: 24,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
    }
  }

  function makeFakeManager(tracked: boolean, calls: FakeManagerCalls) {
    return {
      hasSandbox: () => tracked,
      ensureSandbox: async (sandboxId: string, opts: unknown) => {
        calls.ensured.push({ sandboxId, opts })
        return sandboxId
      },
      spawnShell: (sandboxId: string) => {
        calls.spawned.push(sandboxId)
        return makeFakePty()
      },
    }
  }

  it('does NOT re-ensure a sandbox the manager already tracks', async () => {
    // The WS route ensures the sandbox with its REAL options (squadId, role,
    // etc.) immediately before createSession. A second ensure here with the
    // minimal {workspacePath, hostAccess} options computes a DIFFERENT spec
    // hash on the vm runtime, so its provisioning marker drifts and box-manager
    // takes the full re-provision path — pushing env and RESTARTING the box's
    // systemd unit on every terminal open, then again (marker ping-pong) on the
    // next 60s keep-warm tick, which kills the just-opened shell with a clean
    // "[Process exited with code 0]".
    const calls: FakeManagerCalls = { ensured: [], spawned: [] }
    const { TerminalManager } = await import('./terminal')
    const manager = new TerminalManager(() => makeFakeManager(true, calls) as never)
    const session = await manager.createSession('squad_abc', 80, 24, '/tmp/ws')
    expect(calls.ensured).toEqual([])
    expect(calls.spawned).toEqual(['squad_abc'])
    manager.killSession(session.sessionId)
    manager.cleanup()
  })

  it('still lazily ensures an untracked sandbox when given a workspacePath', async () => {
    const calls: FakeManagerCalls = { ensured: [], spawned: [] }
    const { TerminalManager } = await import('./terminal')
    const manager = new TerminalManager(() => makeFakeManager(false, calls) as never)
    const session = await manager.createSession('squad_abc', 80, 24, '/tmp/ws')
    expect(calls.ensured).toEqual([{ sandboxId: 'squad_abc', opts: { workspacePath: '/tmp/ws', hostAccess: true } }])
    expect(calls.spawned).toEqual(['squad_abc'])
    manager.killSession(session.sessionId)
    manager.cleanup()
  })
})
