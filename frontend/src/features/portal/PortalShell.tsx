import { CalendarDays, ChevronDown, CreditCard, FlaskConical, FolderHeart, GraduationCap, LogOut, Mail, Menu, Pill, Video, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../../design-system/lib/cn'
import { usePortalApi } from './api/portalApi'
import { useResource } from './api/useResource'
import { accentFor } from './accent'
import { pathEnabled } from './features'
import { Link, useRouter } from './router'
import { useSession } from './session'
import { SourceCodeLink } from './sourceCode'

/*
 * The old portal's menus, with text labels (the old desktop menu was icons with tooltips only):
 * Test Results, a Health Summary dropdown, Appointments, Messages, Prescriptions, Billing, Video
 * Consult and Patient Education; the name menu has Demographics, E-Signature, Password and security
 * (the patient realm's account page, D85) and Log out. On phones, a hamburger opens the old side panel with Medical Records and Messages groups.
 */

const HEALTH_SUMMARY = [
  { to: '/health-issues', label: 'Health Issues' },
  { to: '/health-trends', label: 'Health Trends' },
  { to: '/allergies', label: 'Allergies' },
  { to: '/immunizations', label: 'Immunization' },
  { to: '/patient-documents', label: 'Patient Documents' },
  { to: '/reports', label: 'Reports' },
  { to: '/document-templates', label: 'Document Template' },
].filter((i) => pathEnabled(i.to))

const ACCOUNT = [
  { to: '/demographics', label: 'Demographics' },
  { to: '/e-signature', label: 'E-Signature' },
]

const TOP = [
  { to: '/test-results', label: 'Test Results', icon: FlaskConical },
  { to: '/appointments', label: 'Appointments', icon: CalendarDays },
  { to: '/messages/inbox', label: 'Messages', icon: Mail, match: '/messages' },
  { to: '/prescriptions', label: 'Prescriptions', icon: Pill },
  { to: '/billing', label: 'Billing', icon: CreditCard },
  { to: '/video-consult', label: 'Video Consult', icon: Video },
  { to: '/patient-education', label: 'Patient Education', icon: GraduationCap },
].filter((i) => pathEnabled(i.to))

/** Up to two initials from the name the portal greets the patient by. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase()
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

export function PortalShell({ children }: { children: ReactNode }) {
  const { path } = useRouter()
  const { session, signOut } = useSession()
  const api = usePortalApi()
  const inbox = useResource(() => api.listMessages('inbox'), [path])
  const unread = inbox.status === 'ready' ? inbox.data.items.filter((m) => !m.read).length : 0
  const [open, setOpen] = useState<'none' | 'health' | 'account' | 'mobile'>('none')

  // Menus close when the page changes (state adjusted during render, not in an effect).
  const [menuPath, setMenuPath] = useState(path)
  if (menuPath !== path) {
    setMenuPath(path)
    setOpen('none')
  }

  const name = session.patient.displayName
  const healthCurrent = HEALTH_SUMMARY.some((h) => under(path, h.to))

  return (
    <div className={cn('portal portal-page flex min-h-dvh flex-col', accentFor(path).className)}>
      <a href="#main" className="sr-only z-50 rounded-lg bg-surface-1 px-4 py-3 font-semibold text-primary-700 focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to main content
      </a>

      <header className="portal-header sticky top-0 z-30 text-white shadow-card-lg">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-4">
          <button
            type="button"
            className="tap-target -ml-2 inline-flex items-center justify-center rounded-lg text-white hover:bg-white/15 xl:hidden"
            aria-expanded={open === 'mobile'}
            aria-controls="mobile-nav"
            onClick={() => setOpen((o) => (o === 'mobile' ? 'none' : 'mobile'))}
          >
            {open === 'mobile' ? <X aria-hidden="true" size={22} /> : <Menu aria-hidden="true" size={22} />}
            <span className="sr-only">Menu</span>
          </button>

          <Link to="/" className="flex min-h-11 items-center gap-2 rounded-lg pr-2" aria-label="Shri Health patient portal, home">
            <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-xl bg-white text-sm font-extrabold text-indigo-800 shadow-card">
              SH
            </span>
            <span className="hidden flex-col leading-tight whitespace-nowrap sm:flex">
              <span className="text-sm font-bold text-white">Shri Health</span>
              <span className="text-xs text-white">Patient portal</span>
            </span>
          </Link>

          <nav aria-label="Main" className="hidden flex-1 xl:block">
            <ul className="flex items-center gap-0.5">
              <li>
                <TopLink to="/test-results" label="Test Results" current={under(path, '/test-results')} />
              </li>
              <li className="relative">
                <button
                  type="button"
                  aria-expanded={open === 'health'}
                  aria-controls="health-menu"
                  onClick={() => setOpen((o) => (o === 'health' ? 'none' : 'health'))}
                  className={cn(
                    'flex min-h-11 items-center gap-1 rounded-lg px-2.5 text-sm font-medium whitespace-nowrap',
                    healthCurrent ? 'bg-white font-semibold text-indigo-800' : 'text-white hover:bg-white/15',
                  )}
                >
                  Health Summary <ChevronDown aria-hidden="true" size={14} />
                </button>
                {open === 'health' ? (
                  <DropMenu id="health-menu" onClose={() => setOpen('none')} align="left">
                    {HEALTH_SUMMARY.map((h) => (
                      <MenuLink key={h.to} to={h.to} label={h.label} current={under(path, h.to)} />
                    ))}
                  </DropMenu>
                ) : null}
              </li>
              {TOP.slice(1).map((t) => (
                <li key={t.to}>
                  <TopLink to={t.to} label={t.label} current={under(path, t.match ?? t.to)} badge={t.label === 'Messages' ? unread : 0} />
                </li>
              ))}
            </ul>
          </nav>

          <div className="relative ml-auto">
            <button
              type="button"
              aria-expanded={open === 'account'}
              aria-controls="account-menu"
              onClick={() => setOpen((o) => (o === 'account' ? 'none' : 'account'))}
              className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-medium text-white hover:bg-white/15"
            >
              <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-white text-xs font-bold text-indigo-800">
                {initials(name)}
              </span>
              <span className="hidden whitespace-nowrap sm:inline">{name}</span>
              <ChevronDown aria-hidden="true" size={14} />
              <span className="sr-only">, account menu</span>
            </button>
            {open === 'account' ? (
              <DropMenu id="account-menu" onClose={() => setOpen('none')} align="right">
                {ACCOUNT.map((a) => (
                  <MenuLink key={a.to} to={a.to} label={a.label} current={under(path, a.to)} />
                ))}
                <SecurityLink href={api.accountSecurityUrl} />
                <button type="button" onClick={() => signOut('signed-out')} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-sm text-ink hover:bg-surface-2">
                  <LogOut aria-hidden="true" size={16} /> Log out
                </button>
              </DropMenu>
            ) : null}
          </div>
        </div>
      </header>

      {open === 'mobile' ? <MobileNav path={path} unread={unread} onClose={() => setOpen('none')} onSignOut={() => signOut('signed-out')} /> : null}

      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 pt-6 pb-12 outline-none">
        {children}
      </main>

      <footer className="border-t-4 border-(--accent) bg-surface-1">
        <div className="mx-auto max-w-7xl px-4 py-4 text-xs text-ink-subtle">
          <strong className="text-danger">For a medical emergency, call 911.</strong> Messages are not for urgent needs.{' '}
          <SourceCodeLink className="text-ink-muted" />
        </div>
      </footer>
    </div>
  )
}

function TopLink({ to, label, current, badge = 0 }: { to: string; label: string; current: boolean; badge?: number }) {
  return (
    <Link
      to={to}
      {...(current ? { 'aria-current': 'page' as const } : {})}
      className={cn(
        'flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium whitespace-nowrap',
        current ? 'bg-white font-semibold text-indigo-800' : 'text-white hover:bg-white/15',
      )}
    >
      {label}
      {badge > 0 ? <CountBadge count={badge} /> : null}
    </Link>
  )
}

function CountBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1.5 text-2xs font-bold text-white tabular-nums ring-2 ring-white">
      {count}
      <span className="sr-only"> unread</span>
    </span>
  )
}

/** Password, multi-factor and recovery live in the patient realm's own account page (D85). */
function SecurityLink({ href }: { href: string }) {
  return (
    <a href={href} className="flex min-h-11 items-center rounded-lg px-3 text-sm text-ink hover:bg-surface-2">
      Password and security
    </a>
  )
}

function MenuLink({ to, label, current }: { to: string; label: string; current: boolean }) {
  return (
    <Link
      to={to}
      {...(current ? { 'aria-current': 'page' as const } : {})}
      className={cn('flex min-h-11 items-center rounded-lg px-3 text-sm', current ? 'bg-primary-50 font-medium text-primary-700' : 'text-ink hover:bg-surface-2')}
    >
      {label}
    </Link>
  )
}

/** Closes on Esc or a click outside, and returns focus to the button that opened it. */
function useDismiss(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('a, button')?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        opener?.focus()
      }
    }
    function onPointer(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node) && !(opener && opener.contains(e.target as Node))) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [onClose])
  return ref
}

function DropMenu({ id, onClose, align, children }: { id: string; onClose: () => void; align: 'left' | 'right'; children: ReactNode }) {
  const ref = useDismiss(onClose)
  return (
    <div ref={ref} id={id} className={cn('absolute z-40 mt-2 w-60 rounded-xl border border-border-soft bg-surface-1 p-1.5 shadow-card-lg', align === 'right' ? 'right-0' : 'left-0')}>
      {children}
    </div>
  )
}

/** The old mobile side panel: Medical Records and Messages expand; Messages has Inbox, Sent, Trash. */
function MobileNav({ path, unread, onClose, onSignOut }: { path: string; unread: number; onClose: () => void; onSignOut: () => void }) {
  const api = usePortalApi()
  const ref = useDismiss(onClose)
  const [group, setGroup] = useState<'records' | 'messages' | null>(under(path, '/messages') ? 'messages' : null)
  const records = [{ to: '/test-results', label: 'Test Results' }, ...HEALTH_SUMMARY]
  const row = 'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-base'
  return (
    <div className="fixed inset-0 z-40 xl:hidden">
      <div aria-hidden="true" className="absolute inset-0 bg-scrim" onClick={onClose} />
      <nav ref={ref} id="mobile-nav" aria-label="Main" className="absolute inset-y-0 left-0 w-80 max-w-[85vw] overflow-y-auto bg-surface-1 p-3 shadow-modal">
        <ul className="space-y-1">
          <li>
            <button type="button" aria-expanded={group === 'records'} onClick={() => setGroup((g) => (g === 'records' ? null : 'records'))} className={cn(row, 'justify-between text-ink hover:bg-surface-2')}>
              <span className="flex items-center gap-3">
                <FolderHeart aria-hidden="true" size={20} /> Medical Records
              </span>
              <ChevronDown aria-hidden="true" size={16} className={group === 'records' ? 'rotate-180' : ''} />
            </button>
            {group === 'records' ? (
              <ul className="ml-8 space-y-0.5">
                {records.map((r) => (
                  <li key={r.to}>
                    <MenuLink to={r.to} label={r.label} current={under(path, r.to)} />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
          <li>
            <MobileTop to="/appointments" label="Appointments" icon={CalendarDays} current={under(path, '/appointments')} />
          </li>
          <li>
            <button type="button" aria-expanded={group === 'messages'} onClick={() => setGroup((g) => (g === 'messages' ? null : 'messages'))} className={cn(row, 'justify-between text-ink hover:bg-surface-2')}>
              <span className="flex items-center gap-3">
                <Mail aria-hidden="true" size={20} /> Messages {unread ? <CountBadge count={unread} /> : null}
              </span>
              <ChevronDown aria-hidden="true" size={16} className={group === 'messages' ? 'rotate-180' : ''} />
            </button>
            {group === 'messages' ? (
              <ul className="ml-8 space-y-0.5">
                {(['inbox', 'sent', 'trash'] as const).map((f) => (
                  <li key={f}>
                    <MenuLink to={`/messages/${f}`} label={f[0]?.toUpperCase() + f.slice(1)} current={path === `/messages/${f}`} />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
          {TOP.filter((t) => !['/test-results', '/appointments', '/messages/inbox'].includes(t.to)).map((t) => (
            <li key={t.to}>
              <MobileTop to={t.to} label={t.label} icon={t.icon} current={under(path, t.to)} />
            </li>
          ))}
          <li className="border-t border-border-soft pt-1">
            {ACCOUNT.map((a) => (
              <MenuLink key={a.to} to={a.to} label={a.label} current={under(path, a.to)} />
            ))}
            <SecurityLink href={api.accountSecurityUrl} />
            <button type="button" onClick={onSignOut} className={cn(row, 'text-ink hover:bg-surface-2')}>
              <LogOut aria-hidden="true" size={20} /> Log out
            </button>
          </li>
        </ul>
      </nav>
    </div>
  )
}

function MobileTop({ to, label, icon: Icon, current }: { to: string; label: string; icon: typeof Mail; current: boolean }) {
  return (
    <Link
      to={to}
      {...(current ? { 'aria-current': 'page' as const } : {})}
      className={cn('flex min-h-12 items-center gap-3 rounded-lg px-3 text-base', current ? 'bg-primary-50 text-primary-700' : 'text-ink hover:bg-surface-2')}
    >
      <Icon aria-hidden="true" size={20} /> {label}
    </Link>
  )
}
