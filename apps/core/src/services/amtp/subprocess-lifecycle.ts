interface KillableProcess {
  exited: Promise<unknown>
  kill: (signal: 'SIGTERM' | 'SIGKILL') => unknown
}

export class SubprocessTerminationError extends Error {
  readonly code = 'SUBPROCESS_TERMINATION_UNOBSERVED'
  readonly phase = 'sigkill-exit'

  constructor() {
    super('Subprocess exit was not observed after SIGKILL')
    this.name = 'SubprocessTerminationError'
  }
}

/** Terminates a subprocess and escalates when its graceful shutdown stalls. */
export async function terminateProcess(
  proc: KillableProcess,
  graceMs = 500,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
  killGraceMs = graceMs
): Promise<void> {
  proc.kill('SIGTERM')
  const exited = await Promise.race([
    proc.exited.then(
      () => true,
      () => true
    ),
    sleep(graceMs).then(() => false),
  ])
  if (exited) return

  proc.kill('SIGKILL')
  const killed = await Promise.race([
    proc.exited.then(
      () => true,
      () => true
    ),
    sleep(killGraceMs).then(() => false),
  ])
  if (!killed) throw new SubprocessTerminationError()
}
