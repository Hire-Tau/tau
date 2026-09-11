import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import type { IntegrationConnectionService } from './connection-service'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('integration-revalidation')

export interface RevalidationCandidate {
  id: string
}
export interface RevalidationSource {
  due(now: Date, limit: number): Promise<readonly RevalidationCandidate[]>
}

export class IntegrationRevalidationWorker {
  #runner: PeriodicRunner | null = null
  constructor(
    private readonly source: RevalidationSource,
    private readonly service: IntegrationConnectionService,
    private readonly now = () => new Date()
  ) {}
  start(): void {
    if (this.#runner) return
    this.#runner = createPeriodicRunner({
      name: 'integration-revalidation',
      intervalMs: 60_000,
      runImmediately: true,
      task: () => this.runOnce(),
    })
    this.#runner.start()
  }
  async stop(): Promise<void> {
    const runner = this.#runner
    this.#runner = null
    await runner?.stop()
  }
  async runOnce(): Promise<void> {
    for (const candidate of await this.source.due(this.now(), 10)) {
      // ConnectionService performs network validation outside DB transactions and commits with revision CAS.
      await this.service
        .validate(candidate.id)
        .catch((error) =>
          log.warn(
            `Revalidation failed for connection ${candidate.id}:`,
            error instanceof Error ? error.name : 'unknown'
          )
        )
    }
  }
}
