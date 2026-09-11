import { DockerSandboxCompatibilityError, DockerSandboxLifecycleError } from './errors'

export type LifecycleResult = { exitCode: number; stderr: Buffer }
export type ContainerState = 'running' | 'stopped' | 'not_found' | 'unknown'

export function immutableLifecycleTarget(immutableId: string): string {
  return immutableId
}

export async function runWithPrimaryCleanup<T>(operation: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  try {
    return await operation()
  } catch (primary) {
    const errors = [primary]
    try {
      await cleanup()
    } catch (secondary) {
      if (secondary instanceof AggregateError) errors.push(...secondary.errors)
      else errors.push(secondary)
    }
    if (errors.length === 1) throw primary
    throw new AggregateError(errors, 'Docker sandbox initialization and cleanup failed', { cause: primary })
  }
}

export function activeDriftError(error: unknown, sandboxId: string, containerId: string): unknown {
  if (!(error instanceof DockerSandboxCompatibilityError)) return error
  return new DockerSandboxCompatibilityError({
    operation: 'adopt-active-container',
    sandboxId,
    containerId,
    reason: error.code === 'IDENTITY_MISMATCH' ? 'SECURITY_DRIFT_ACTIVE' : 'LEGACY_RECREATION_DEFERRED',
    cause: error,
  })
}

export function runDestructiveLifecycle(options: {
  operation: 'stop' | 'remove'
  sandboxId: string
  immutableId: string
  containerName: string
  execute: () => LifecycleResult
  inspect: () => ContainerState
  release: () => void
}): void {
  const { operation, sandboxId, immutableId, containerName } = options
  let result: LifecycleResult
  try {
    result = options.execute()
  } catch (cause) {
    throw new DockerSandboxLifecycleError({
      operation,
      sandboxId,
      containerId: immutableId,
      reason: operation === 'stop' ? 'STOP_FAILED' : 'REMOVE_FAILED',
      cause,
    })
  }
  const state = options.inspect()
  const failed =
    operation === 'stop'
      ? state === 'unknown' || state === 'running' || (result.exitCode !== 0 && state !== 'not_found')
      : state !== 'not_found'
  if (failed) {
    throw new DockerSandboxLifecycleError({
      operation,
      sandboxId,
      containerId: immutableId,
      containerName,
      reason: state === 'unknown' ? 'DOCKER_STATE_UNKNOWN' : operation === 'stop' ? 'STOP_FAILED' : 'REMOVE_FAILED',
      stderr: result.stderr.toString(),
    })
  }
  options.release()
}

export function releaseTrackedState(options: {
  sandboxId: string
  containerId?: string
  close?: () => void
  deleteState: () => void
}): void {
  try {
    options.close?.()
  } catch (cause) {
    throw new DockerSandboxLifecycleError({
      operation: 'close-client',
      sandboxId: options.sandboxId,
      containerId: options.containerId,
      reason: 'CLEANUP_UNPROVEN',
      cause,
    })
  }
  options.deleteState()
}

export async function cleanupFailedInitialization(options: {
  remove: () => Promise<void>
  isTracked: () => boolean
  close?: () => void
}): Promise<void> {
  const errors: unknown[] = []
  try {
    await options.remove()
  } catch (error) {
    errors.push(error)
  }
  if (options.isTracked() && options.close) {
    try {
      options.close()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Failed to clean newly created Docker sandbox')
}

export async function cleanupTrackedSandboxes(ids: string[], stop: (id: string) => Promise<void>): Promise<void> {
  const results = await Promise.allSettled(ids.map(stop))
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
  if (failures.length) throw new AggregateError(failures, 'Docker sandbox cleanup was not proven')
}

export function dockerExecWithStdinArgs(
  containerId: string,
  workspaceMount: string,
  userArgs: string[],
  args: string[]
): string[] {
  return ['docker', 'exec', '-i', ...userArgs, '-w', workspaceMount, containerId, ...args]
}
