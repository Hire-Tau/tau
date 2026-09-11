import { accessSync, constants, existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { CommandLogProvider, type SpawnCommand } from './command-provider'
import {
  clampTailLines,
  type SystemLogComponent,
  type SystemLogStreamOptions,
  type SystemLogStreamResult,
  SystemLogProviderError,
} from './types'

export interface FileLogProviderDependencies {
  spawn?: SpawnCommand
  reportDiagnostic?: (message: string, cause?: unknown) => void
}

export function buildTailArgs(filePath: string, opts: SystemLogStreamOptions): string[] {
  return ['tail', '-n', String(clampTailLines(opts.tailLines)), ...(opts.follow ? ['-F'] : []), filePath]
}

/** Streams explicitly configured, readable absolute log files. */
export class FileLogProvider extends CommandLogProvider {
  constructor(
    private readonly paths: Record<SystemLogComponent, string>,
    dependencies: FileLogProviderDependencies = {}
  ) {
    for (const path of Object.values(paths)) {
      if (!isAbsolute(path)) {
        throw new SystemLogProviderError('CONFIG_INVALID', 'Configured system log file paths must be absolute.')
      }
    }
    super(
      'file',
      (component, opts) => ({ component, kind: 'file', argv: buildTailArgs(paths[component], opts) }),
      dependencies.spawn,
      dependencies.reportDiagnostic,
      'Unable to read configured file logs; check file paths and permissions.'
    )
  }

  override stream(...args: Parameters<CommandLogProvider['stream']>): SystemLogStreamResult {
    const [components] = args
    for (const component of components) {
      const path = this.paths[component]
      try {
        if (!existsSync(path)) {
          throw new SystemLogProviderError('TARGET_NOT_FOUND', 'A configured system log file was not found.')
        }
        accessSync(path, constants.R_OK)
      } catch (error) {
        if (error instanceof SystemLogProviderError) throw error
        throw new SystemLogProviderError('ACCESS_DENIED', 'A configured system log file is not readable.', {
          cause: error,
        })
      }
    }
    return super.stream(...args)
  }
}
