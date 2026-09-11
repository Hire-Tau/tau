import type { Subagent } from '../../entities/Subagent'

/** Keep the watchdog snapshot and the on-demand status tool consistent. */
export function formatSubagentStatuses(children: Awaited<ReturnType<typeof Subagent.listChildren>>): string {
  return children.length === 0
    ? 'No subagents.'
    : children
        .map(
          (child) =>
            `${child.label} (${child.subagentId}): ${child.status}${child.resultStatus ? `, result=${child.resultStatus}` : ''}${child.lastActivityAt ? `, lastActivityAt=${child.lastActivityAt}` : ''}`
        )
        .join('\n')
}
