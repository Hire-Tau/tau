import clsx from 'clsx'
import type { SandboxStatus } from '../../api/workspace'
import { resolveSandboxStyle } from './sandboxStatusStyles'

/** The dot + label + reason display shared by every sandbox widget. */
export function SandboxStatusBadge({ status }: { status: SandboxStatus }) {
  const { config, reason } = resolveSandboxStyle(status)
  return (
    <span className={clsx('inline-flex items-center gap-1.5 text-sm', config.color)}>
      <span className="relative flex h-2 w-2">
        {config.pulse && (
          <span
            className={clsx('absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping', config.dotColor)}
          />
        )}
        <span className={clsx('relative inline-flex h-2 w-2 rounded-full', config.dotColor)} />
      </span>
      <span title={`Sandbox: ${config.label}${reason}`}>
        {config.label}
        {reason}
      </span>
    </span>
  )
}
