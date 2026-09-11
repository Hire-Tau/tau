import { Squad } from '../../../entities/Squad'
import { PeriodicRunner } from '../../../lib/infra/PeriodicRunner'
import { createLogger } from '../../../lib/infra/logger'
import { ExternalSourceReindexService } from './ExternalSourceReindexService'

const log = createLogger('external-source-reindex-runner')

export interface ExternalSourceReindexRunnerOptions {
  intervalMs?: number
  runImmediately?: boolean
}

export class ExternalSourceReindexRunner extends PeriodicRunner {
  private static _instance: ExternalSourceReindexRunner | null = null

  static instance(): ExternalSourceReindexRunner {
    if (!ExternalSourceReindexRunner._instance) {
      ExternalSourceReindexRunner._instance = new ExternalSourceReindexRunner()
    }
    return ExternalSourceReindexRunner._instance
  }

  static _reset(): void {
    if (ExternalSourceReindexRunner._instance) {
      void ExternalSourceReindexRunner._instance.stop()
    }
    ExternalSourceReindexRunner._instance = null
  }

  constructor(options: ExternalSourceReindexRunnerOptions = {}) {
    super({
      name: 'external-source-reindex',
      intervalMs: options.intervalMs ?? 30 * 60 * 1000,
      runImmediately: options.runImmediately ?? false,
    })
  }

  protected async runTask(): Promise<void> {
    const squads = await Squad.list()
    let indexed = 0
    let skipped = 0
    let failed = 0

    for (const squad of squads) {
      try {
        const report = await ExternalSourceReindexService.instance().reindexSquad(squad.id)
        for (const summary of Object.values(report)) {
          indexed += summary.indexed
          skipped += summary.skipped
          failed += summary.failed
        }
      } catch (err) {
        failed++
        const message = err instanceof Error ? err.message : String(err)
        log.warn(`Failed external source reindex for squad ${squad.id}: ${message}`)
      }
    }

    log.info(
      `External source reindex complete: squads=${squads.length} indexed=${indexed} skipped=${skipped} failed=${failed}`
    )
  }
}
