import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { findActiveDeviceTokenIds } from './device-tokens'
import {
  crossProcessDeviceTokenEvents,
  subscribeToLocalDeviceTokenRevocations,
  type DeviceTokenEventAdapter,
} from './device-token-events'

export interface DeviceConnectionHandle {
  dispose(): void
  isActive(): boolean
}

type ConnectionState = 'pending' | 'active' | 'revoked'
interface ConnectionRecord {
  state: ConnectionState
  terminate: () => void
}
export type FindActiveDeviceTokenIds = (ids: string[]) => Promise<Set<string>>
type RunnerFactory = typeof createPeriodicRunner

/** Process-local admission registry containing durable device UUIDs only. */
export class DeviceConnectionRegistry {
  private readonly records = new Map<string, Set<ConnectionRecord>>()
  private runner: PeriodicRunner | null = null
  private unlisten: (() => void | Promise<void>) | null = null
  private stopping = false

  constructor(
    private readonly findActiveIds: FindActiveDeviceTokenIds,
    private readonly events?: DeviceTokenEventAdapter,
    private readonly createRunner: RunnerFactory = createPeriodicRunner
  ) {}

  async register(deviceTokenId: string, terminate: () => void): Promise<DeviceConnectionHandle> {
    const record: ConnectionRecord = { state: 'pending', terminate }
    const handle: DeviceConnectionHandle = {
      dispose: () => this.dispose(deviceTokenId, record),
      isActive: () => record.state === 'active',
    }
    if (this.stopping) {
      this.terminate(record)
      return handle
    }

    let records = this.records.get(deviceTokenId)
    if (!records) this.records.set(deviceTokenId, (records = new Set()))
    records.add(record)

    let active: Set<string>
    try {
      active = await this.findActiveIds([deviceTokenId])
    } catch (error) {
      this.deny(deviceTokenId, record)
      throw error
    }
    if (record.state !== 'pending') return handle
    if (this.stopping || !active.has(deviceTokenId)) {
      this.deny(deviceTokenId, record)
      return handle
    }
    record.state = 'active'
    return handle
  }

  revoke(deviceTokenId: string): void {
    const records = this.records.get(deviceTokenId)
    if (!records) return
    this.records.delete(deviceTokenId)
    for (const record of records) this.terminate(record)
  }

  async revalidate(): Promise<void> {
    const ids = [...this.records.keys()]
    if (ids.length === 0) return
    const active = await this.findActiveIds(ids)
    for (const id of ids) if (!active.has(id)) this.revoke(id)
  }

  async start(): Promise<void> {
    if (this.runner || this.stopping) return
    if (this.events) {
      const unlisten = await this.events.subscribe((id) => this.revoke(id))
      this.unlisten = unlisten ?? null
    }
    this.runner = this.createRunner({
      name: 'device-connection-revalidation',
      // Backstop only: revocation is delivered immediately by the event
      // subscription above (same-process and cross-process). At 1s this was the
      // tightest loop in the codebase — a device_tokens ⋈ users query every
      // second for as long as any client was connected (86k/day) to bound how
      // long a MISSED event could linger. 30s bounds it just as well.
      intervalMs: 30_000,
      runImmediately: false,
      task: () => this.revalidate(),
    })
    this.runner.start()
  }

  async stop(): Promise<void> {
    this.stopping = true
    for (const id of [...this.records.keys()]) this.revoke(id)
    const runner = this.runner
    this.runner = null
    await runner?.stop()
    const unlisten = this.unlisten
    this.unlisten = null
    await unlisten?.()
    this.records.clear()
  }

  connectionCount(deviceTokenId: string): number {
    return this.records.get(deviceTokenId)?.size ?? 0
  }

  private dispose(deviceTokenId: string, record: ConnectionRecord): void {
    if (record.state === 'revoked') return
    record.state = 'revoked'
    this.remove(deviceTokenId, record)
  }

  private deny(deviceTokenId: string, record: ConnectionRecord): void {
    if (record.state === 'revoked') return
    this.remove(deviceTokenId, record)
    this.terminate(record)
  }

  private terminate(record: ConnectionRecord): void {
    if (record.state === 'revoked') return
    record.state = 'revoked'
    try {
      record.terminate()
    } catch {
      // A broken transport cleanup must not prevent the remaining connections
      // for this credential from being denied and terminated.
    }
  }

  private remove(deviceTokenId: string, record: ConnectionRecord): void {
    const records = this.records.get(deviceTokenId)
    records?.delete(record)
    if (records?.size === 0) this.records.delete(deviceTokenId)
  }
}

export const deviceConnectionRegistry = new DeviceConnectionRegistry(
  findActiveDeviceTokenIds,
  crossProcessDeviceTokenEvents
)

// Eager synchronous subscription: async subsystem startup only adds peer events and polling.
subscribeToLocalDeviceTokenRevocations((deviceTokenId) => deviceConnectionRegistry.revoke(deviceTokenId))

export function startDeviceConnectionRevocation(): Promise<void> {
  return deviceConnectionRegistry.start()
}
export function stopDeviceConnectionRevocation(): Promise<void> {
  return deviceConnectionRegistry.stop()
}
