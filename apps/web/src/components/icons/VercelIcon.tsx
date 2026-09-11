import type { IconProps } from './types'

// Brand mark from Simple Icons (CC0): https://raw.githubusercontent.com/simple-icons/simple-icons/14.0.0/icons/vercel.svg
export function VercelIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M24 22.525H0l12-21.05 12 21.05z" />
    </svg>
  )
}
