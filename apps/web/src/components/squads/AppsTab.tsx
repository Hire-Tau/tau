import { LocalDeploymentsPanel } from './LocalDeploymentsPanel'
import { ExternalDeploymentsPanel } from './ExternalDeploymentsPanel'

interface AppsTabProps {
  squadId: string
}

export function AppsTab({ squadId }: AppsTabProps) {
  return (
    <div className="h-full overflow-y-auto space-y-4 min-w-0">
      <ExternalDeploymentsPanel squadId={squadId} />
      <section className="pb-4 min-w-0 overflow-hidden">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-primary">Local Apps</h3>
          <p className="text-xs text-muted mt-1">Private sandbox local apps running in this squad workspace.</p>
        </div>
        <LocalDeploymentsPanel squadId={squadId} />
      </section>
    </div>
  )
}
