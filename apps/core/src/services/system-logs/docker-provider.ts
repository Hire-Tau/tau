import { CommandLogProvider, type SpawnCommand } from './command-provider'
import { clampTailLines, type SystemLogComponent, type SystemLogStreamOptions, SystemLogProviderError } from './types'

export function buildDockerLogsArgs(container: string, opts: SystemLogStreamOptions): string[] {
  return [
    'docker',
    'logs',
    '--tail',
    String(clampTailLines(opts.tailLines)),
    ...(opts.follow ? ['--follow'] : []),
    container,
  ]
}

function validateContainer(container: string): string {
  if (!container.trim() || /[\0\n\r]/.test(container)) {
    throw new SystemLogProviderError('CONFIG_INVALID', 'Configured Docker container names are invalid.')
  }
  return container
}

export class DockerLogProvider extends CommandLogProvider {
  constructor(
    containers: Record<SystemLogComponent, string>,
    dependencies: { spawn?: SpawnCommand; reportDiagnostic?: (message: string, cause?: unknown) => void } = {}
  ) {
    const targets = { api: validateContainer(containers.api), worker: validateContainer(containers.worker) }
    super(
      'docker',
      (component, opts) => ({ component, kind: 'container', argv: buildDockerLogsArgs(targets[component], opts) }),
      dependencies.spawn,
      dependencies.reportDiagnostic,
      'Unable to read configured Docker logs; check daemon access and container names.'
    )
  }
}
