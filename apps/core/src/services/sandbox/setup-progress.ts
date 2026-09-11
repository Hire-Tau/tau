import type { ISandboxManager } from './types'

export type SandboxSetupWorkReason =
  | 'runtime_start'
  | 'runtime_reconnect'
  | 'spec_reconcile'
  | 'asset_reconcile'
  | 'setup_reconcile'
  | 'toolchain_reconcile'

export type SandboxSetupProgressEvent =
  | {
      type: 'started'
      operationId: string
      sandboxId: string
      reason: SandboxSetupWorkReason
    }
  | {
      type: 'finished'
      operationId: string
      sandboxId: string
      outcome: 'ready' | 'failed'
    }

export type SandboxSetupProgressListener = (event: SandboxSetupProgressEvent) => void

type ActiveOperation = Extract<SandboxSetupProgressEvent, { type: 'started' }>

class SandboxSetupProgressHub {
  private readonly nonce = Math.random().toString(36).slice(2)
  private nextOperationId = 0
  private readonly active = new Map<string, Map<string, ActiveOperation>>()
  private readonly listeners = new Map<string, Set<SandboxSetupProgressListener>>()

  observe(sandboxId: string, listener: SandboxSetupProgressListener): () => void {
    let listeners = this.listeners.get(sandboxId)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(sandboxId, listeners)
    }
    listeners.add(listener)

    for (const event of this.active.get(sandboxId)?.values() ?? []) this.notify(listener, event)

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sandboxId)
    }
  }

  begin(sandboxId: string, reason: SandboxSetupWorkReason): (outcome: 'ready' | 'failed') => void {
    const operationId = `${this.nonce}-${++this.nextOperationId}`
    const event: ActiveOperation = { type: 'started', operationId, sandboxId, reason }
    let active = this.active.get(sandboxId)
    if (!active) {
      active = new Map()
      this.active.set(sandboxId, active)
    }
    active.set(operationId, event)
    this.publish(event)

    let finished = false
    return (outcome) => {
      if (finished) return
      finished = true
      active.delete(operationId)
      if (active.size === 0) this.active.delete(sandboxId)
      this.publish({ type: 'finished', operationId, sandboxId, outcome })
    }
  }

  private publish(event: SandboxSetupProgressEvent): void {
    for (const listener of this.listeners.get(event.sandboxId) ?? []) this.notify(listener, event)
  }

  private notify(listener: SandboxSetupProgressListener, event: SandboxSetupProgressEvent): void {
    try {
      listener(event)
    } catch {
      // Progress reporting is observational and must never change sandbox behavior.
    }
  }
}

const progressHubs = new WeakMap<ISandboxManager, SandboxSetupProgressHub>()

function getProgressHub(manager: ISandboxManager): SandboxSetupProgressHub {
  let hub = progressHubs.get(manager)
  if (!hub) {
    hub = new SandboxSetupProgressHub()
    progressHubs.set(manager, hub)
  }
  return hub
}

export function observeSandboxSetupProgress(
  manager: ISandboxManager,
  sandboxId: string,
  listener: SandboxSetupProgressListener
): () => void {
  return getProgressHub(manager).observe(sandboxId, listener)
}

export function beginSandboxSetupWork(
  manager: ISandboxManager,
  sandboxId: string,
  reason: SandboxSetupWorkReason
): (outcome: 'ready' | 'failed') => void {
  return getProgressHub(manager).begin(sandboxId, reason)
}

export async function trackSandboxSetupWork<T>(
  manager: ISandboxManager,
  sandboxId: string,
  reason: SandboxSetupWorkReason,
  operation: () => Promise<T>
): Promise<T> {
  const finish = beginSandboxSetupWork(manager, sandboxId, reason)
  try {
    const result = await operation()
    finish('ready')
    return result
  } catch (error) {
    finish('failed')
    throw error
  }
}
