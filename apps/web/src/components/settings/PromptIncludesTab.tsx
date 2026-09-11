import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Modal } from '../Modal'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import {
  createPromptInclude,
  deletePromptInclude,
  disablePromptInclude,
  enablePromptInclude,
  revertPromptInclude,
  revertPromptIncludeFields,
  updatePromptInclude,
  type PromptIncludeConfig,
} from '../../api/config'
import { TemplateFieldActions } from './TemplateFieldActions'
import { usePermissions } from '../../hooks/usePermissions'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'

/**
 * The API refuses to delete an include an agent type still references and names
 * the referencing types in `referencedBy`. The thrown Error only carries the
 * message, so pull the ids off the parsed payload and show them together.
 */
export function deleteErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const payload = (error as { payload?: unknown } | null)?.payload
  const referencedBy =
    payload && typeof payload === 'object' ? (payload as { referencedBy?: unknown }).referencedBy : undefined
  if (Array.isArray(referencedBy) && referencedBy.length) return `${message} — used by: ${referencedBy.join(', ')}`
  return message
}

/** Pure list of include cards — rendered by the tab, testable without a query client. */
export function PromptIncludeList({
  includes,
  onEdit,
  onToggle,
  onDelete,
  canWrite,
}: {
  includes: PromptIncludeConfig[]
  onEdit: (include: PromptIncludeConfig) => void
  onToggle: (include: PromptIncludeConfig) => void
  onDelete: (include: PromptIncludeConfig) => void
  canWrite: boolean
}) {
  if (!includes.length) return <p className="py-8 text-center text-muted">No prompt includes configured.</p>
  return (
    <div className="space-y-3">
      {includes.map((include) => (
        <article
          key={include.id}
          className="min-w-0 rounded-xl border border-panel-border bg-surface p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-3"
        >
          <div className="min-w-0">
            <div className="font-semibold text-primary flex items-center gap-2 flex-wrap">
              <span>{include.name}</span>
              {include.yamlFieldOverrides.length > 0 && (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                  Modified from template
                </span>
              )}
              {include.disabled && (
                <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-[11px] text-muted">Disabled</span>
              )}
            </div>
            <div className="text-xs text-muted font-mono">{include.id}</div>
            {include.description && <p className="text-sm text-secondary mt-1">{include.description}</p>}
          </div>
          <div className="flex gap-2 shrink-0 flex-wrap justify-end">
            {canWrite && (
              <button className="tau-button text-sm text-accent-light" onClick={() => onEdit(include)}>
                Edit
              </button>
            )}
            {canWrite && (
              <button className="tau-button text-sm text-muted" onClick={() => onToggle(include)}>
                {include.disabled ? 'Enable' : 'Disable'}
              </button>
            )}
            {canWrite && !include.hasTemplate && (
              <button className="tau-button text-sm text-red-600" onClick={() => onDelete(include)}>
                Delete
              </button>
            )}
          </div>
        </article>
      ))}
    </div>
  )
}

type IncludeDraft = { id: string; name: string; description: string; content: string }

export function PromptIncludesTab() {
  const queryClient = useQueryClient()
  const { data: includes = [], isLoading } = useQuery(queries.promptIncludes.list())
  const loadingCardCount = useLoadingShapeCount('settings:prompt-includes', isLoading ? undefined : includes.length, {
    fallbackCount: 4,
    maxCount: 10,
  })
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canWrite = !permissionsLoading && can('agent-types:update')
  const [editing, setEditing] = useState<IncludeDraft | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const existing = editing && !isNew ? includes.find((include) => include.id === editing.id) : undefined
  const editingDiffQuery = useQuery({
    ...queries.promptIncludes.templateDiff(existing?.hasTemplate ? existing.id : ''),
    enabled: !!existing?.hasTemplate,
  })

  // Include content feeds every agent type's resolved prompt, so refresh the
  // agent type caches alongside the include list.
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.promptIncludes.all })
    queryClient.invalidateQueries({ queryKey: queryKeys.agentTypes.all })
  }

  const save = useMutation({
    mutationFn: (draft: IncludeDraft) =>
      isNew
        ? createPromptInclude({
            id: draft.id.trim(),
            name: draft.name.trim(),
            content: draft.content,
            description: draft.description.trim() || null,
          })
        : updatePromptInclude(draft.id, {
            content: draft.content,
            name: draft.name.trim(),
            description: draft.description.trim() || null,
          }),
    onSuccess: () => {
      setEditing(null)
      invalidate()
    },
  })

  const toggle = useMutation({
    mutationFn: (include: PromptIncludeConfig) =>
      include.disabled ? enablePromptInclude(include.id) : disablePromptInclude(include.id),
    onSuccess: invalidate,
  })

  const remove = useMutation({
    mutationFn: (include: PromptIncludeConfig) => deletePromptInclude(include.id),
    onSuccess: () => {
      setDeleteError('')
      invalidate()
    },
    onError: (error) => setDeleteError(deleteErrorMessage(error)),
  })

  const revertAll = useMutation({
    mutationFn: (id: string) => revertPromptInclude(id),
    onSuccess: (_data, id) => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: queryKeys.promptIncludes.templateDiff(id) })
    },
  })

  const revertFields = useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: string[] }) => revertPromptIncludeFields(id, fields),
    onSuccess: (_data, variables) => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: queryKeys.promptIncludes.templateDiff(variables.id) })
    },
  })

  // A revert rewrites the stored record, so refresh the open editor from the
  // refetched include instead of leaving the pre-revert text on screen.
  useEffect(() => {
    if (!existing) return
    setEditing((draft) =>
      draft && draft.id === existing.id
        ? { ...draft, name: existing.name, description: existing.description ?? '', content: existing.content }
        : draft
    )
  }, [existing])

  const fieldActions = (field: string) =>
    existing?.hasTemplate ? (
      <TemplateFieldActions
        field={field}
        current={editingDiffQuery.data?.current ?? null}
        template={editingDiffQuery.data?.template ?? null}
        fieldOverrides={editingDiffQuery.data?.fieldOverrides ?? existing.yamlFieldOverrides}
        onRevert={(field) => canWrite && revertFields.mutate({ id: existing.id, fields: [field] })}
        isReverting={revertFields.isPending}
      />
    ) : null

  const openEditor = (include: PromptIncludeConfig) => {
    save.reset()
    setIsNew(false)
    setEditing({
      id: include.id,
      name: include.name,
      description: include.description ?? '',
      content: include.content,
    })
  }

  const openNew = () => {
    save.reset()
    setIsNew(true)
    setEditing({ id: '', name: '', description: '', content: '' })
  }

  if (isLoading) return <CollectionSkeleton label="Loading prompt includes" count={loadingCardCount} layout="cards" />

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted">
          Shared prompt blocks agent types compose into their system prompt, in the order each type lists them.
        </p>
        {canWrite && (
          <button
            className="tau-button tau-button-primary shrink-0 px-3 py-1.5 text-sm bg-accent text-white rounded-md"
            onClick={openNew}
          >
            New include
          </button>
        )}
      </div>

      {deleteError && <div className="text-sm text-red-600 dark:text-red-400">{deleteError}</div>}

      <PromptIncludeList
        includes={includes}
        onEdit={openEditor}
        onToggle={(include) => toggle.mutate(include)}
        onDelete={(include) => {
          setDeleteError('')
          if (window.confirm(`Delete prompt include "${include.name}"? This cannot be undone.`)) remove.mutate(include)
        }}
        canWrite={canWrite}
      />

      {editing && (
        <Modal
          isOpen
          onClose={() => setEditing(null)}
          title={isNew ? 'New prompt include' : `Edit ${editing.name}`}
          maxWidth="wide"
        >
          <form
            className="space-y-4"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setEditing(null)
              }
            }}
            onSubmit={(event) => {
              event.preventDefault()
              save.mutate(editing)
            }}
          >
            <div>
              <label className="text-xs text-muted mb-1 block">Include ID</label>
              <input
                className="tau-field w-full px-3 py-2 bg-input border border-th-border"
                aria-label="Include ID"
                required
                placeholder="squad-rules"
                value={editing.id}
                disabled={!isNew}
                onChange={(event) => setEditing({ ...editing, id: event.target.value })}
              />
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Name</label>
              <input
                className="tau-field w-full px-3 py-2 bg-input border border-th-border"
                aria-label="Name"
                required
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              />
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Description</label>
              <input
                className="tau-field w-full px-3 py-2 bg-input border border-th-border"
                aria-label="Description"
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
              />
            </div>
            <div>
              <label className="text-xs text-muted flex items-center gap-2 mb-1">
                <span>Content</span>
                {fieldActions('content')}
              </label>
              <textarea
                className="tau-field w-full px-3 py-2 font-mono text-sm bg-input border border-th-border"
                aria-label="Content"
                required
                rows={18}
                value={editing.content}
                onChange={(event) => setEditing({ ...editing, content: event.target.value })}
              />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                className="tau-button tau-button-primary px-3 py-1.5 text-sm bg-accent text-white rounded-md disabled:opacity-50"
                disabled={save.isPending}
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="tau-button px-3 py-1.5 text-sm bg-surface-hover rounded-md"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              {existing?.hasTemplate && existing.yamlFieldOverrides.length > 0 && (
                <button
                  type="button"
                  className="tau-button px-3 py-1.5 text-sm text-amber-600 dark:text-amber-400 disabled:opacity-50"
                  disabled={revertAll.isPending}
                  onClick={() => {
                    if (window.confirm(`Revert "${existing.id}" to its template?`)) revertAll.mutate(existing.id)
                  }}
                >
                  Revert to template
                </button>
              )}
              {save.isError && (
                <span className="text-xs text-red-600 dark:text-red-400">{(save.error as Error).message}</span>
              )}
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
