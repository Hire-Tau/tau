import clsx from 'clsx'
import { Link } from 'react-router-dom'

export type BadgeColor =
  | 'gray'
  | 'red'
  | 'orange'
  | 'amber'
  | 'yellow'
  | 'lime'
  | 'green'
  | 'emerald'
  | 'teal'
  | 'cyan'
  | 'sky'
  | 'blue'
  | 'indigo'
  | 'violet'
  | 'purple'
  | 'fuchsia'
  | 'pink'
  | 'rose'

const COLOR_CLASSES: Record<BadgeColor, string> = {
  gray: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  red: 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-200',
  orange: 'bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-200',
  amber: 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200',
  yellow: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200',
  lime: 'bg-lime-100 dark:bg-lime-900/30 text-lime-800 dark:text-lime-200',
  green: 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200',
  emerald: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200',
  teal: 'bg-teal-100 dark:bg-teal-900/30 text-teal-800 dark:text-teal-200',
  cyan: 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-800 dark:text-cyan-200',
  sky: 'bg-sky-100 dark:bg-sky-900/30 text-sky-800 dark:text-sky-200',
  blue: 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200',
  indigo: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200',
  violet: 'bg-violet-100 dark:bg-violet-900/30 text-violet-800 dark:text-violet-200',
  purple: 'bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-200',
  fuchsia: 'bg-fuchsia-100 dark:bg-fuchsia-900/30 text-fuchsia-800 dark:text-fuchsia-200',
  pink: 'bg-pink-100 dark:bg-pink-900/30 text-pink-800 dark:text-pink-200',
  rose: 'bg-rose-100 dark:bg-rose-900/30 text-rose-800 dark:text-rose-200',
}

const HOVER_CLASSES: Record<BadgeColor, string> = {
  gray: 'hover:bg-gray-200 dark:hover:bg-gray-700',
  red: 'hover:bg-red-200 dark:hover:bg-red-900/70',
  orange: 'hover:bg-orange-200 dark:hover:bg-orange-900/70',
  amber: 'hover:bg-amber-200 dark:hover:bg-amber-900/70',
  yellow: 'hover:bg-yellow-200 dark:hover:bg-yellow-900/70',
  lime: 'hover:bg-lime-200 dark:hover:bg-lime-900/70',
  green: 'hover:bg-green-200 dark:hover:bg-green-900/70',
  emerald: 'hover:bg-emerald-200 dark:hover:bg-emerald-900/70',
  teal: 'hover:bg-teal-200 dark:hover:bg-teal-900/70',
  cyan: 'hover:bg-cyan-200 dark:hover:bg-cyan-900/70',
  sky: 'hover:bg-sky-200 dark:hover:bg-sky-900/70',
  blue: 'hover:bg-blue-200 dark:hover:bg-blue-900/70',
  indigo: 'hover:bg-indigo-200 dark:hover:bg-indigo-900/70',
  violet: 'hover:bg-violet-200 dark:hover:bg-violet-900/70',
  purple: 'hover:bg-purple-200 dark:hover:bg-purple-900/70',
  fuchsia: 'hover:bg-fuchsia-200 dark:hover:bg-fuchsia-900/70',
  pink: 'hover:bg-pink-200 dark:hover:bg-pink-900/70',
  rose: 'hover:bg-rose-200 dark:hover:bg-rose-900/70',
}

interface BadgeProps {
  children: React.ReactNode
  color?: BadgeColor
  /** If provided, renders as a Link */
  to?: string
  /** Click handler (for non-link badges) */
  onClick?: (e: React.MouseEvent) => void
  className?: string
  title?: string
}

const BASE_CLASSES = 'inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium leading-4'

export function Badge({ children, color = 'gray', to, onClick, className, title }: BadgeProps) {
  const colorClasses = COLOR_CLASSES[color]

  if (to) {
    return (
      <Link
        to={to}
        onClick={onClick}
        className={clsx(BASE_CLASSES, colorClasses, HOVER_CLASSES[color], 'transition-colors', className)}
        title={title}
      >
        {children}
      </Link>
    )
  }

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={clsx('tau-button', BASE_CLASSES, colorClasses, HOVER_CLASSES[color], 'transition-colors', className)}
        title={title}
      >
        {children}
      </button>
    )
  }

  return (
    <span className={clsx(BASE_CLASSES, colorClasses, className)} title={title}>
      {children}
    </span>
  )
}

// Re-export color for convenience
export { COLOR_CLASSES as BADGE_COLORS }
