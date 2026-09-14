import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { updateChannelInstance } from '../../api/config'
import { SquadOverridesEditor, TrustedChannelsField } from '../settings/ChannelsSection'
import {
  type ProviderId,
  type OverrideRow,
  mapToOverrideRows,
  overrideRowsToMap,
  invalidOverrideRowIndexes,
} from '../settings/channelFormHelpers'

/** One routing policy for the identity discovered from this provider's connection. */
export function ProviderChannelRouting({
  provider,
  instanceId,
  canWrite,
}: {
  provider: ProviderId
  instanceId: string
  canWrite: boolean
}) {
  const client = useQueryClient()
  const query = useQuery(queries.channelInstances.detail(instanceId))
  const [rows, setRows] = useState<OverrideRow[]>([])
  const [trusted, setTrusted] = useState('')
  const [allowed, setAllowed] = useState('')
  const [denied, setDenied] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (!query.data) return
    setRows(mapToOverrideRows(query.data.channelSquadMap))
    setTrusted((query.data.trustedChannelIds ?? []).join(', '))
    setAllowed((query.data.allowedChannelIds ?? []).join(', '))
    setDenied((query.data.deniedChannelIds ?? []).join(', '))
  }, [query.data])
  const save = useMutation({
    mutationFn: () =>
      updateChannelInstance(instanceId, {
        channelSquadMap: overrideRowsToMap(rows),
        trustedChannelIds: trusted.split(/[,\s]+/).filter(Boolean),
        allowedChannelIds: allowed.split(/[,\s]+/).filter(Boolean),
        deniedChannelIds: denied.split(/[,\s]+/).filter(Boolean),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.channelInstances.all }),
  })
  return (
    <section className="space-y-4 text-sm" aria-label="Channel routing and access">
      <div>
        <h4 className="font-medium text-primary">Channel routing and access</h4>
        <p className="text-muted mt-1">
          Overrides select a squad for a specific channel or chat on this connection. Other messages use the default
          squad above.
        </p>
      </div>
      {query.isPending ? (
        <p className="text-muted">Loading routing…</p>
      ) : query.isError ? (
        <p role="alert">{query.error.message}</p>
      ) : (
        <fieldset disabled={!canWrite || save.isPending} className="space-y-4">
          <SquadOverridesEditor provider={provider} rows={rows} onChange={setRows} />
          {(provider === 'slack' || provider === 'discord') && (
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="font-medium">Allowed channel IDs</span>
                <input
                  className="tau-field w-full px-3 py-2"
                  value={allowed}
                  onChange={(e) => setAllowed(e.target.value)}
                  placeholder="All channels when empty"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Denied channel IDs</span>
                <input
                  className="tau-field w-full px-3 py-2"
                  value={denied}
                  onChange={(e) => setDenied(e.target.value)}
                  placeholder="No denied channels"
                />
              </label>
              <p className="text-muted">
                Separate IDs with commas or spaces. Denied channels always win, including for linked users and trusted
                channels. Threads inherit their parent channel’s policy. Tau ignores messages in excluded channels,
                including help and account linking.
              </p>
            </div>
          )}
          <TrustedChannelsField value={trusted} onChange={setTrusted} />
          {canWrite && (
            <button
              className="tau-button tau-button-primary px-3 py-2"
              onClick={() => {
                if (invalidOverrideRowIndexes(rows).length) {
                  setError('Complete each override or remove its row.')
                  return
                }
                setError('')
                save.mutate()
              }}
            >
              Save routing and access
            </button>
          )}
          {save.isSuccess && (
            <p className="text-muted" role="status">
              Saved.
            </p>
          )}
          {(error || save.error) && (
            <p role="alert" className="text-danger">
              {error || save.error?.message}
            </p>
          )}
        </fieldset>
      )}
    </section>
  )
}
