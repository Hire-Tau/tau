import { createPeriodicRunner, type PeriodicRunner } from '../../../lib/infra/PeriodicRunner'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import type { IntegrationExportWorker } from './worker'
import type { ExportCompletionProjector } from './completion-projector'
import { createLogger } from '../../../lib/infra/logger'

const log = createLogger('integration-export')

export class IntegrationExportRuntime {
  #runner: PeriodicRunner | null = null
  #unsubscribe: (() => void) | null = null
  constructor(
    private readonly worker: IntegrationExportWorker,
    private readonly projector: ExportCompletionProjector
  ) {}
  start(): void {
    if (this.#runner) return
    this.#unsubscribe = eventEmitter.on('execution.completed', ({ executionId }) => {
      void this.projector
        .handle(executionId)
        .then(() => this.worker.runOnce())
        .catch((error) =>
          log.warn(
            'Export completion processing failed with sanitized error class:',
            error instanceof Error ? error.name : 'unknown'
          )
        )
    })
    this.#runner = createPeriodicRunner({
      name: 'integration-export-outbox',
      intervalMs: 30_000,
      runImmediately: true,
      task: async () => {
        for (let i = 0; i < 10 && (await this.worker.runOnce()); i++);
      },
    })
    this.#runner.start()
  }
  async stop(): Promise<void> {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    const runner = this.#runner
    this.#runner = null
    await runner?.stop()
  }
}
