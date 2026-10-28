import { createContext, useCallback, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'

/**
 * A small history-based router for the portal: real URLs, so Back, bookmarks and "open in new tab"
 * work. Paths carry opaque UUIDs only, never names or dates of birth (D13). Flow state (a refill
 * being requested, a time being booked) lives in components, not in the URL.
 */

export const PORTAL_BASE = '/portal'

interface RouterApi {
  /** Path inside the portal, e.g. `/appointments/3f2…`. */
  path: string
  navigate: (to: string, options?: { replace?: boolean }) => void
}

const RouterContext = createContext<RouterApi | null>(null)

function currentPath(): string {
  const p = window.location.pathname
  const inner = p.startsWith(PORTAL_BASE) ? p.slice(PORTAL_BASE.length) : p
  return inner === '' ? '/' : inner
}

export function PortalRouter({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(currentPath)

  useEffect(() => {
    const onPop = () => setPath(currentPath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((to: string, options: { replace?: boolean } = {}) => {
    const url = PORTAL_BASE + (to === '/' ? '' : to)
    if (options.replace) window.history.replaceState(null, '', url)
    else window.history.pushState(null, '', url)
    setPath(to)
    window.scrollTo({ top: 0 })
  }, [])

  const api = useMemo(() => ({ path, navigate }), [path, navigate])
  return <RouterContext.Provider value={api}>{children}</RouterContext.Provider>
}

export function useRouter(): RouterApi {
  const api = useContext(RouterContext)
  if (!api) throw new Error('useRouter must be used inside <PortalRouter>')
  return api
}

/** Matches `/appointments/:appointmentId` against a path; returns the params or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean)
  const b = path.split('/').filter(Boolean)
  if (a.length !== b.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < a.length; i++) {
    const seg = a[i] ?? ''
    const val = b[i] ?? ''
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(val)
    else if (seg !== val) return null
  }
  return params
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string
}

/** An ordinary link (middle-click and Ctrl-click still open a new tab) that routes in place. */
export function Link({ to, onClick, children, ...rest }: LinkProps) {
  const { navigate } = useRouter()
  function handle(e: MouseEvent<HTMLAnchorElement>) {
    onClick?.(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }
  return (
    <a href={PORTAL_BASE + (to === '/' ? '' : to)} onClick={handle} {...rest}>
      {children}
    </a>
  )
}
