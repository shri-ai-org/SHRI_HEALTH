import { Link } from '../router'
import { PageHeader } from '../ui'

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" description="The link may be old, or the page may have moved." />
      <Link to="/" className="inline-flex min-h-11 items-center rounded-lg bg-primary-600 px-4 text-sm font-semibold text-on-primary hover:bg-primary-700">
        Go to home
      </Link>
    </>
  )
}
