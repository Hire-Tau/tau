import { isWorkerAgentType } from '@tau/shared'
import clsx from 'clsx'
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { spawnSquadAgent } from '../../api/squads'
import { Modal } from '../Modal'
import { SpinnerIcon } from '../icons'
import { LoadingSurface, SkeletonBlock, SkeletonLine } from '../loading/Skeleton'

interface SpawnAgentModalProps {
  squadId: string
  onClose: () => void
  onSpawned?: (agentId: string) => void
}

export function SpawnAgentModal({ squadId, onClose, onSpawned }: SpawnAgentModalProps) {
  const queryClient = useQueryClient()
  const [selectedTypeId, setSelectedTypeId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  const { data: agentTypes = [], isLoading: typesLoading } = useQuery(queries.agentTypes.list())

  // Filter out system/non-spawnable types and sort alphabetically
  const spawnableTypes = useMemo(() => {
    return agentTypes.filter(isWorkerAgentType).sort((a, b) => a.name.localeCompare(b.name))
  }, [agentTypes])

  const spawnMutation = useMutation({
    mutationFn: (agentTypeId: string) => spawnSquadAgent(squadId, agentTypeId),
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.agents(squadId) })
      onSpawned?.(agent.id)
      onClose()
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to spawn agent')
    },
  })

  const handleSpawn = () => {
    if (!selectedTypeId) return
    setError(null)
    spawnMutation.mutate(selectedTypeId)
  }

  return (
    <Modal isOpen onClose={onClose} title="Spawn Agent">
      <div className="space-y-4">
        {typesLoading ? (
          <LoadingSurface label="Loading agent types" className="space-y-4">
            <div className="space-y-1">
              <span className="block text-sm font-medium text-primary">Agent Type</span>
              <SkeletonBlock className="h-10 w-full" />
              <SkeletonLine className="mt-2 w-3/5" />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="tau-button rounded-md border border-th-border px-3 py-1.5 text-sm font-medium text-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled
                className="tau-button tau-button-primary rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent opacity-50"
              >
                Spawn
              </button>
            </div>
          </LoadingSurface>
        ) : (
          <>
            <div>
              <label className="block text-sm font-medium text-primary mb-1">Agent Type</label>
              <select
                value={selectedTypeId}
                onChange={(e) => setSelectedTypeId(e.target.value)}
                className={clsx(
                  'tau-field',
                  `w-full px-3 py-2 text-sm border border-th-border bg-surface rounded-md  focus:ring-2 focus:ring-accent ${selectedTypeId ? 'text-primary' : 'text-muted'}`
                )}
              >
                <option value="">Select agent type...</option>
                {spawnableTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name} ({type.id})
                  </option>
                ))}
              </select>
              {selectedTypeId && (
                <p className="mt-1 text-xs text-muted">
                  {spawnableTypes.find((t) => t.id === selectedTypeId)?.description || 'No description available'}
                </p>
              )}
            </div>

            {error && (
              <div className="p-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/30 dark:text-red-400 rounded border border-red-200 dark:border-red-800">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="tau-button px-3 py-1.5 text-sm font-medium text-secondary border border-th-border rounded-md hover:bg-surface-hover transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSpawn}
                disabled={!selectedTypeId || spawnMutation.isPending}
                className="tau-button tau-button-primary px-3 py-1.5 text-sm font-medium text-on-accent bg-accent rounded-md hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
              >
                {spawnMutation.isPending && <SpinnerIcon className="w-4 h-4 animate-spin" />}
                Spawn
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
