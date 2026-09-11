import { createPeriodicRunner, type PeriodicRunner } from '@tau/shared'
import {
  RELAY_MAX_RESPONSE_BYTES,
  relayStatusResponse,
  relaySuccessResponse,
  relayPullResponse,
  type RelayDelivery,
} from '@tau/shared/integration-relay'
import { PlatformRequestError, type platformRequest } from '../../platform/instance-client'
import type { RepositoryInterest } from './github-interests'

export interface RelayConnection {
  id: string
  revision: string
  accessToken: string
}
export interface HostedRelayDependencies {
  managed(): boolean
  interests(): Promise<RepositoryInterest[]>
  resolve(connectionId: string): Promise<RelayConnection | undefined>
  request: typeof platformRequest
  dispatch(delivery: RelayDelivery, interests: RepositoryInterest[]): Promise<void>
  now?(): number
  onError(code: string): void
}
const RENEW_MS = 5 * 60_000

/** Ephemeral discovery cache; durable ownership, queue and leases remain on Platform. */
export class HostedIntegrationRelayRunner {
  private runner: PeriodicRunner | undefined
  private controller = new AbortController()
  private renewAt = new Map<string, { key: string; at: number }>()
  private retryAt = new Map<string, number>()
  private remote: { connectionId: string; connectionRevision: string }[] = []
  private statusAt = 0
  private enabled = false
  private offset = 0
  private scan: Promise<void> | undefined
  constructor(private readonly deps: HostedRelayDependencies) {}
  start() {
    if (!this.deps.managed() || this.runner) return
    this.controller = new AbortController()
    this.runner = createPeriodicRunner({ name: 'hosted-integration-relay', intervalMs: 5_000, task: () => this.tick() })
    this.runner.start()
  }
  async stop() {
    this.controller.abort()
    const runner = this.runner
    this.runner = undefined
    await runner?.stop()
    await this.scan
  }
  tick(): Promise<void> {
    if (!this.deps.managed() || this.controller.signal.aborted) return Promise.resolve()
    if (!this.scan)
      this.scan = this.run().finally(() => {
        this.scan = undefined
      })
    return this.scan
  }
  private call<T>(
    path: string,
    body: unknown,
    schema: Parameters<typeof platformRequest<T>>[0]['schema'],
    timeoutMs = 30_000
  ) {
    return this.deps.request({
      path: `/api/integration-relay/github/${path}`,
      body,
      schema,
      signal: this.controller.signal,
      timeoutMs,
      maxResponseBytes: RELAY_MAX_RESPONSE_BYTES,
    })
  }
  private async run() {
    const now = this.deps.now?.() ?? Date.now()
    try {
      if (now >= this.statusAt) {
        // Also back off when an older Platform has no relay route/scopes yet.
        this.statusAt = now + RENEW_MS
        const status = await this.call('status', {}, relayStatusResponse)
        this.enabled = status.enabled
        this.remote = status.connections
      }
      if (!this.enabled) return
      const interests = await this.deps.interests()
      const groups = new Map<string, RepositoryInterest[]>()
      for (const interest of interests)
        groups.set(interest.connectionId, [...(groups.get(interest.connectionId) ?? []), interest])
      for (const connection of this.remote) {
        if (groups.has(connection.connectionId)) continue
        await this.call('unsubscribe', connection, relaySuccessResponse)
        this.renewAt.delete(connection.connectionId)
      }
      this.remote = this.remote.filter((connection) => groups.has(connection.connectionId))
      const ids = [...groups.keys()].sort()
      const selected = Array.from(
        { length: Math.min(4, ids.length) },
        (_, index) => ids[(this.offset + index) % ids.length]!
      )
      this.offset = ids.length ? (this.offset + selected.length) % ids.length : 0
      for (const id of selected) {
        if (this.controller.signal.aborted) break
        if ((this.retryAt.get(id) ?? 0) > now) continue
        try {
          const connection = await this.deps.resolve(id)
          if (!connection) continue
          const repositories = [...new Set(groups.get(id)!.map((interest) => interest.repository))].sort()
          // Fail closed instead of silently watching an arbitrary subset.
          if (repositories.length > 100) throw new PlatformRequestError('repository_limit', false)
          const revisionKey = JSON.stringify([id, connection.revision, repositories])
          if (this.renewAt.get(id)?.key !== revisionKey || this.renewAt.get(id)!.at <= now) {
            await this.call(
              'subscribe',
              {
                connectionId: id,
                connectionRevision: connection.revision,
                accessToken: connection.accessToken,
                repositories,
              },
              relaySuccessResponse,
              180_000
            )
            this.renewAt.set(id, { key: revisionKey, at: now + RENEW_MS })
          }
          const owner = { connectionId: id, connectionRevision: connection.revision }
          const result = await this.call(
            'pull',
            { ...owner, accessToken: connection.accessToken },
            relayPullResponse,
            60_000
          )
          const acknowledgments: { id: string; leaseToken: string }[] = []
          for (const delivery of result.deliveries) {
            if (this.controller.signal.aborted) break
            if (delivery.connectionId !== id || delivery.connectionRevision !== connection.revision)
              throw new PlatformRequestError('invalid_response', false)
            // Re-read after the network boundary: a detach/reconnect cannot receive a queued old event.
            const live = await this.deps.resolve(id)
            if (!live || live.revision !== connection.revision) break
            const current = (await this.deps.interests()).filter(
              (interest) => interest.connectionId === id && interest.repository === delivery.resourceKey
            )
            if (current.length) await this.deps.dispatch(delivery, current)
            acknowledgments.push({ id: delivery.id, leaseToken: delivery.leaseToken })
          }
          if (acknowledgments.length)
            await this.call('ack', { ...owner, deliveries: acknowledgments }, relaySuccessResponse)
          this.retryAt.delete(id)
        } catch (error) {
          this.retryAt.set(id, now + 60_000)
          this.report(error)
        }
      }
      for (const id of this.retryAt.keys()) if (!groups.has(id)) this.retryAt.delete(id)
      for (const id of this.renewAt.keys()) if (!groups.has(id)) this.renewAt.delete(id)
    } catch (error) {
      this.report(error)
    }
  }
  private report(error: unknown) {
    if (!this.controller.signal.aborted)
      this.deps.onError(error instanceof PlatformRequestError ? error.code : 'relay_unavailable')
  }
}
