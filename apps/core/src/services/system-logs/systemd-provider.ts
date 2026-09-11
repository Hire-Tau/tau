import { CommandLogProvider, type SpawnCommand } from './command-provider'
import { clampTailLines, type SystemLogComponent, type SystemLogStreamOptions, SystemLogProviderError } from './types'

export function buildJournalctlArgs(unit: string, opts: SystemLogStreamOptions): string[] {
  return [
    'journalctl',
    '--unit',
    unit,
    '--lines',
    String(clampTailLines(opts.tailLines)),
    '--output=cat',
    '--no-pager',
    ...(opts.follow ? ['--follow'] : []),
  ]
}

function validateUnit(unit: string): string {
  if (!unit.trim() || /[\0\n\r/]/.test(unit)) {
    throw new SystemLogProviderError('CONFIG_INVALID', 'Configured systemd unit names are invalid.')
  }
  return unit
}

export class SystemdLogProvider extends CommandLogProvider {
  constructor(
    units: Record<SystemLogComponent, string>,
    dependencies: { spawn?: SpawnCommand; reportDiagnostic?: (message: string, cause?: unknown) => void } = {}
  ) {
    const targets = { api: validateUnit(units.api), worker: validateUnit(units.worker) }
    super(
      'systemd',
      (component, opts) => ({ component, kind: 'unit', argv: buildJournalctlArgs(targets[component], opts) }),
      dependencies.spawn,
      dependencies.reportDiagnostic,
      'Unable to read configured systemd logs; check journal permissions and unit names.'
    )
  }
}
