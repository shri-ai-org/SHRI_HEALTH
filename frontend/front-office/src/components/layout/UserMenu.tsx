import { useCallback, useRef, useState } from 'react'
import { LogOut } from 'lucide-react'
import { Avatar } from '../ui/Avatar'
import { useDismiss } from '../../hooks/useDismiss'
import { useCurrentUser } from '../../../shri-health/user'
import { useSession } from '../../../../src/api/session'

/** Who is signed in at this desk (DESIGN_SYSTEM §8.6 identity), and **Sign out**: it ends our
 *  session and the Keycloak session, then goes straight to the sign-in form, so the next person
 *  at a shared desk can sign in at once (src/api/session.tsx). */
export function UserMenu() {
  const user = useCurrentUser()
  const { signOut } = useSession()
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, rootRef, triggerRef)

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Signed in as ${user.name} · ${user.role}`}
        className="focus-ring flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-1 transition-colors hover:bg-surface-2"
      >
        <Avatar name={user.name} initials={user.initials} size="sm" />
        <span className="hidden min-w-0 max-w-[160px] text-left 2xl:block">
          <span className="block truncate text-sm font-medium leading-tight text-ink">{user.name}</span>
          <span className="block truncate text-xs leading-tight text-ink-subtle">{user.role}</span>
        </span>
        <span className="sr-only">
          Signed in as {user.name}, {user.role}
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-[calc(100%+6px)] z-40 w-60 overflow-hidden rounded-xl border border-border-soft bg-surface-1 py-1 shadow-card-lg"
        >
          <div className="px-3 py-2">
            <div className="truncate text-sm font-medium text-ink">{user.name}</div>
            <div className="truncate text-xs text-ink-subtle">{user.role}</div>
          </div>
          <div className="border-t border-border-soft" />
          <button
            type="button"
            role="menuitem"
            disabled={leaving}
            onClick={() => {
              setLeaving(true)
              void signOut()
            }}
            className="focus-ring flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-medium text-critical-fg transition-colors hover:bg-critical-bg disabled:opacity-60"
          >
            <LogOut size={16} aria-hidden="true" />
            {leaving ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
