import { Link, useLocation } from 'react-router-dom'
import { Compass, LayoutGrid } from 'lucide-react'
import { EmptyState } from '../components/ui/EmptyState'

/** An address that leads nowhere — said plainly, with the way back. */
export function NotFoundPage() {
  const { pathname } = useLocation()
  return (
    <EmptyState
      icon={Compass}
      title="This page doesn't exist"
      description={<span className="break-all font-medium text-ink">{pathname}</span>}
      action={
        <Link
          to="/"
          className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-semibold text-on-primary transition-colors hover:bg-primary-700"
        >
          <LayoutGrid size={16} aria-hidden="true" />
          Go to the dashboard
        </Link>
      }
    />
  )
}
