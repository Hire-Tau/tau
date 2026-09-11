export type DockerSandboxReason =
  | 'IMAGE_REBUILD_REQUIRED'
  | 'LEGACY_RECREATION_DEFERRED'
  | 'LEGACY_OWNERSHIP_UNPROVEN'
  | 'EXECUTOR_MISSING'
  | 'PROTOCOL_MISMATCH'
  | 'CAPABILITY_MISSING'
  | 'IDENTITY_MISMATCH'
  | 'SECURITY_DRIFT_ACTIVE'
  | 'START_FAILED'
  | 'STOP_FAILED'
  | 'REMOVE_FAILED'
  | 'CLEANUP_UNPROVEN'
  | 'DOCKER_STATE_UNKNOWN'

export interface DockerSandboxErrorOptions {
  operation: string
  reason: DockerSandboxReason
  sandboxId?: string
  containerName?: string
  containerId?: string
  stderr?: string
  cause?: unknown
}

const MAX_STDERR = 512
function sanitizeStderr(stderr: string | undefined): string | undefined {
  if (!stderr) return undefined
  return stderr
    .replace(/(?:EXECUTOR_[A-Z_]*(?:TOKEN|SECRET)|AUTHORIZATION)\s*[=:]\s*\S+/gi, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, MAX_STDERR)
}

abstract class DockerSandboxError extends Error {
  readonly code: DockerSandboxReason
  readonly operation: string
  readonly sandboxId?: string
  readonly containerName?: string
  readonly containerId?: string
  readonly stderr?: string

  protected constructor(name: string, options: DockerSandboxErrorOptions, action?: string) {
    const target = options.sandboxId ?? options.containerName ?? options.containerId ?? 'sandbox'
    super(`${options.operation} failed for ${target}: ${options.reason}${action ? `. ${action}` : ''}`, {
      cause: options.cause,
    })
    this.name = name
    this.code = options.reason
    this.operation = options.operation
    this.sandboxId = options.sandboxId
    this.containerName = options.containerName
    this.containerId = options.containerId
    this.stderr = sanitizeStderr(options.stderr)
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      operation: this.operation,
      sandboxId: this.sandboxId,
      containerName: this.containerName,
      containerId: this.containerId,
      stderr: this.stderr,
      message: this.message,
    }
  }
}

export class DockerSandboxCompatibilityError extends DockerSandboxError {
  constructor(options: DockerSandboxErrorOptions) {
    super(
      'DockerSandboxCompatibilityError',
      options,
      options.reason === 'IMAGE_REBUILD_REQUIRED' ? 'Run bun run sandbox:build:docker' : undefined
    )
  }
}

export class DockerSandboxLifecycleError extends DockerSandboxError {
  constructor(options: DockerSandboxErrorOptions) {
    super('DockerSandboxLifecycleError', options)
  }
}
