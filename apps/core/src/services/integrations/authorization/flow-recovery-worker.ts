import { createPeriodicRunner, type PeriodicRunner } from '../../../lib/infra/PeriodicRunner'
import type { OAuthStateRepository } from './state-repository'

export class AuthorizationFlowRecoveryWorker {
  #runner: PeriodicRunner | null = null

  constructor(private readonly states: Pick<OAuthStateRepository, 'deleteExpired'>) {}

  async runOnce(): Promise<void> {
    await this.states.deleteExpired()
  }

  start(): void {
    if (this.#runner) return
    this.#runner = createPeriodicRunner({
      name: 'integration-oauth-flow-recovery',
      intervalMs: 30_000,
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
}
