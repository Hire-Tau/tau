import { Link } from 'react-router-dom'

export function BackLink({ to, children, onClick }: { to: string; children: string; onClick?: () => void }) {
  return (
    <Link to={to} onClick={onClick} className="text-sm text-muted hover:text-secondary">
      &larr; {children}
    </Link>
  )
}
