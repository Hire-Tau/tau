import type { IconProps } from './types'

// Brand mark from Simple Icons (CC0): https://raw.githubusercontent.com/simple-icons/simple-icons/14.0.0/icons/supabase.svg
export function SupabaseIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z" />
    </svg>
  )
}
