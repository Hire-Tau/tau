import { createPeriodicRunner, type PeriodicRunner } from '../../../lib/infra/PeriodicRunner'
import { parseOAuthCredential } from './credential-bundle'
import { shouldProactivelyRefresh } from './refresh-service'

export interface IntegrationRefreshWorkerDependencies {
  oauthProviderKeys(): readonly string[]
  listConnections(
    providerKey: string,
    currentAuthority: 'local' | 'platform_broker',
    afterId: string | null,
    limit: number,
    authorityFilter: 'matching' | 'mismatched'
  ): Promise<
    readonly {
      id: string
      credentialRef: string
      enabled: boolean
      authState: string
      clientAuthority: 'local' | 'platform_broker'
    }[]
  >
  credentials: { get(key: string): string | undefined }
  currentAuthority(providerKey: string): 'local' | 'platform_broker'
  refresh(connectionId: string, reason: 'proactive'): Promise<unknown>
  now?: () => Date
  refreshWindowMs?: number
}

export class IntegrationRefreshWorker {
  readonly #dependencies: IntegrationRefreshWorkerDependencies
  readonly #now: () => Date
  readonly #refreshWindowMs: number
  #runner: PeriodicRunner | null = null
  readonly #matchingCursor = new Map<string, string>()
  readonly #mismatchedCursor = new Map<string, string>()

  constructor(dependencies: IntegrationRefreshWorkerDependencies) {
    this.#dependencies = dependencies
    this.#now = dependencies.now ?? (() => new Date())
    this.#refreshWindowMs = dependencies.refreshWindowMs ?? 5 * 60_000
  }

  async runOnce(): Promise<number> {
    let refreshed = 0
    for (const providerKey of [...this.#dependencies.oauthProviderKeys()].sort()) {
      const currentAuthority = this.#dependencies.currentAuthority(providerKey)
      const page = async (authorityFilter: 'matching' | 'mismatched', cursors: Map<string, string>) => {
        const cursor = cursors.get(providerKey) ?? null
        let rows = await this.#dependencies.listConnections(providerKey, currentAuthority, cursor, 25, authorityFilter)
        if (rows.length === 0 && cursor) {
          cursors.delete(providerKey)
          rows = await this.#dependencies.listConnections(providerKey, currentAuthority, null, 25, authorityFilter)
        }
        if (rows.length) cursors.set(providerKey, rows.at(-1)!.id)
        return rows
      }
      const batch = [
        ...(await page('mismatched', this.#mismatchedCursor)),
        ...(await page('matching', this.#matchingCursor)),
      ]
      for (const connection of batch) {
        if (connection.clientAuthority !== currentAuthority) {
          try {
            await this.#dependencies.refresh(connection.id, 'proactive')
          } catch {
            // Authority reconciliation is retried on a later rotating sweep.
          }
          continue
        }
        const raw = this.#dependencies.credentials.get(connection.credentialRef)
        if (!raw) continue
        try {
          const credential = parseOAuthCredential(raw)
          if (!shouldProactivelyRefresh(credential, this.#now(), this.#refreshWindowMs)) continue
          await this.#dependencies.refresh(connection.id, 'proactive')
          refreshed += 1
        } catch {
          // One malformed credential/provider failure must not block the sweep.
        }
      }
    }
    return refreshed
  }

  start(): void {
    if (this.#runner) return
    this.#runner = createPeriodicRunner({
      name: 'integration-oauth-refresh',
      intervalMs: 60_000,
      runImmediately: true,
      task: () => this.runOnce().then(() => undefined),
    })
    this.#runner.start()
  }

  async stop(): Promise<void> {
    const runner = this.#runner
    this.#runner = null
    await runner?.stop()
  }
}
