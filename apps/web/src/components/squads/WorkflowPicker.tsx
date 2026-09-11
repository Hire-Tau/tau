import { useQuery } from '@tanstack/react-query'
import { resolveWorkflow, type WorkflowSource } from '@tau/shared'
import { queries } from '../../queryOptions'
import { WorkflowGraph } from '../WorkflowGraph'

/** Squad settings select existing flows; their definitions are managed in Administration. */
export function WorkflowPicker({
  squadId,
  value,
  onChange,
  disabled,
  preview = true,
  onUseSquadDefault,
}: {
  squadId?: string
  value?: WorkflowSource
  onChange: (source: WorkflowSource) => void
  disabled?: boolean
  preview?: boolean
  onUseSquadDefault?: () => void
}) {
  const catalog = useQuery(queries.workflows.list())
  const entries = (catalog.data ?? []).filter(
    (entry) =>
      !entry.disabled &&
      (!entry.scope ||
        entry.scope.kind === 'instance' ||
        (entry.scope.kind === 'squad' && entry.scope.squadId === squadId))
  )
  const selected = value?.kind === 'preset' ? catalog.data?.find((entry) => entry.id === value.id) : undefined
  let definition = value?.kind === 'inline' ? value.definition : undefined
  let error: string | undefined
  if (value?.kind === 'preset' && selected) {
    try {
      definition = resolveWorkflow(value, selected).definition
    } catch (cause) {
      error = (cause as Error).message
    }
  }
  return (
    <div className="min-w-0 space-y-3">
      <label className="block text-sm font-medium">
        Workflow
        <select
          className="tau-field mt-1 w-full min-w-0 rounded-md border border-th-border bg-surface px-3 py-2"
          disabled={disabled || catalog.isPending || catalog.isError}
          value={value?.kind === 'preset' ? value.id : value ? '__inline' : ''}
          onChange={(event) =>
            event.target.value
              ? onChange({ kind: 'preset', id: event.target.value, customizations: [] })
              : onUseSquadDefault?.()
          }
        >
          <option value="" disabled={!onUseSquadDefault}>
            {onUseSquadDefault ? 'Use squad default' : 'Choose a workflow'}
          </option>
          {value?.kind === 'inline' && (
            <option value="__inline" disabled>
              {value.definition.name} (saved custom flow)
            </option>
          )}
          {value?.kind === 'preset' && !entries.some((entry) => entry.id === value.id) && (
            <option value={value.id} disabled>
              {selected?.definition.name ?? value.id} (unavailable)
            </option>
          )}
          {entries.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.definition.name}
            </option>
          ))}
        </select>
      </label>
      {(catalog.isError || error) && (
        <p role="alert" className="text-xs text-danger">
          {error ?? 'Unable to load workflows.'}
        </p>
      )}
      {preview && definition && <WorkflowGraph definition={definition} />}
    </div>
  )
}
