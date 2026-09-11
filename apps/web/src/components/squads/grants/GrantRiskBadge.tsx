import type { GrantRisk } from './grantRisks'

interface Props {
  risks: GrantRisk[]
}

const SEVERITY_STYLES: Record<GrantRisk['severity'], string> = {
  low: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  medium: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  high: 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200',
}

export function GrantRiskBadge({ risks }: Props) {
  if (risks.length === 0) return null

  const highest = risks.reduce<GrantRisk['severity']>((acc, risk) => {
    if (risk.severity === 'high') return 'high'
    if (risk.severity === 'medium' && acc !== 'high') return 'medium'
    return acc
  }, 'low')

  return (
    <details className="inline-block">
      <summary
        className={`cursor-pointer inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded ${SEVERITY_STYLES[highest]}`}
      >
        ⚠ {risks.length} warning{risks.length === 1 ? '' : 's'}
      </summary>
      <ul className="mt-2 ml-4 space-y-1 text-xs text-secondary list-disc">
        {risks.map((risk) => (
          <li key={risk.code}>{risk.message}</li>
        ))}
      </ul>
    </details>
  )
}
