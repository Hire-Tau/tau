import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { queries } from '../queryOptions'
import { usePermissions } from '../hooks/usePermissions'

export function StorageBanner() {
  const { can, isLoading } = usePermissions()
  const allowed = !isLoading && can('system:logs')
  const { data } = useQuery({ ...queries.system.storageStatus(), enabled: allowed })
  if (!allowed || !data?.warnings.length) return null
  const worst = [...data.warnings].sort((a, b) => b.percent - a.percent)[0]!
  return (
    <div role="status" className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-primary">
      Storage warning: {worst.machineName} was {worst.percent.toFixed(1)}% full at{' '}
      {new Date(worst.measuredAt).toLocaleString()}.
      {worst.stale ? ' This reading is stale; current usage is unknown.' : ''}
      {data.warnings.length > 1 ? ` ${data.warnings.length} machines need attention.` : ''}{' '}
      <Link to="/settings?section=storage" className="inline-flex items-center underline">
        Review storage
      </Link>
    </div>
  )
}
