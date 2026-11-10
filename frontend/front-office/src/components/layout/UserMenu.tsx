import { Avatar } from '../ui/Avatar'
import { useCurrentUser } from '../../hooks/useCurrentUser'

/** Who is signed in at this desk (DESIGN_SYSTEM §8.6 identity). There is one
 *  user for now, so this is a name card, not a menu. */
export function UserMenu() {
  const user = useCurrentUser()
  return (
    <div className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-1" title={`Signed in as ${user.name} · ${user.role}`}>
      <Avatar name={user.name} initials={user.initials} size="sm" />
      <span className="hidden min-w-0 max-w-[160px] text-left 2xl:block">
        <span className="block truncate text-sm font-medium leading-tight text-ink">{user.name}</span>
        <span className="block truncate text-xs leading-tight text-ink-subtle">{user.role}</span>
      </span>
      <span className="sr-only">
        Signed in as {user.name}, {user.role}
      </span>
    </div>
  )
}
