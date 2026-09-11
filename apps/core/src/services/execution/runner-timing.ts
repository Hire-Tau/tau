import { createLogger } from '../../lib/infra/logger'

const log = createLogger('runner-timing')

export interface RunnerTiming {
  executionId: string
  agentId: string
  runnerType: string
  enteredRunAt: number
}

export type RunnerTimingMilestone = 'started' | 'session-ready' | 'prompt-sent' | 'first-output'

export function startRunnerTiming(input: Omit<RunnerTiming, 'enteredRunAt'>): RunnerTiming {
  return { ...input, enteredRunAt: Date.now() }
}

export function logRunnerMilestone(timing: RunnerTiming, milestone: RunnerTimingMilestone): void {
  log.debug(
    `${milestone} executionId=${timing.executionId} agent=${timing.agentId} runner=${timing.runnerType} elapsedMs=${Date.now() - timing.enteredRunAt}`
  )
}
