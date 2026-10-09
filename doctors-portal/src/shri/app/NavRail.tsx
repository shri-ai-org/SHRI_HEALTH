/**
 * §4.2 — the black capsule rail, 76px collapsed / 220px expanded, and the
 * bottom tab bar it becomes under 768px.
 */

import { AnimatePresence, motion } from 'framer-motion'
import {
  Aperture, BedDouble, Brain, Ellipsis, FlaskConical, House, ListChecks, LogOut, Search, Sparkles, Stethoscope, UsersRound, Video,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

import { assistantRouteFor, navGroupsFor, type NavItem } from '@/atlas/nav'
import type { PersonaId } from '@/atlas/personas'
import { screenForPath } from '@/atlas/registry'
import { useClinical } from '@/store/clinical'
import { useSession } from '@/store/session'

import { cn } from '../lib/cn'
import { T220, sheetUp } from '../lib/motion'
import { useWaiting } from '../telehealth/waitingRoom'
import { unacknowledgedCritical } from '../myday/useMyDay'
import { useShri } from '../state/store'
import { useMediaQuery, useOutsideClick } from '../ui/hooks'
import { Icon } from '../ui/primitives'

import { canonical } from './paths'

type Section = NavItem['section']

interface RailItem {
  key: Section | 'patients' | 'search' | 'more'
  label: string
  /** The phone tab bar's label. */
  short: string
  icon: LucideIcon
  to?: string
  action?: 'search' | 'more'
  title?: string
}

/** The icon each of the old rail's sections wears here — the destinations are the old build's, the look is this one's. */
const SECTION_ICON: Record<Section, LucideIcon> = {
  home: House,
  queue: Stethoscope,
  inpatients: BedDouble,
  results: FlaskConical,
  orders: ListChecks,
  discharge: LogOut,
  imaging: Aperture,
  stroke: Brain,
  telehealth: Video,
  assistant: Sparkles,
}

function railItem(n: NavItem, persona: PersonaId): RailItem {
  const base = { key: n.section, label: n.label, short: n.short, icon: SECTION_ICON[n.section] }
  // The assistant a persona gets is the one for their portal (`assistantRouteFor`): stroke staff get the stroke one.
  if (n.section === 'assistant') return { ...base, to: assistantRouteFor(persona) }
  return { ...base, to: canonical(n.to) }
}

/**
 * The old rail's OPD and Inpatients are one item here, "My patients", where
 * the lists are tabs (`patients/MyPatientsFrame.tsx`). It sits where the first
 * of the two sat and opens the first list the persona may open.
 */
const PATIENT_LISTS: ReadonlySet<Section> = new Set(['queue', 'inpatients'])

function mergePatientLists(items: RailItem[]): RailItem[] {
  const lists = items.filter((i) => PATIENT_LISTS.has(i.key as Section))
  if (lists.length === 0) return items
  const merged: RailItem = { key: 'patients', label: 'My patients', short: 'Patients', icon: UsersRound, to: lists[0].to }
  const at = items.indexOf(lists[0])
  const rest = items.filter((i) => !lists.includes(i))
  return [...rest.slice(0, at), merged, ...rest.slice(at)]
}

const SEARCH: RailItem = { key: 'search', label: 'Patient search', short: 'Search', icon: Search, action: 'search', title: 'Patient search  /' }
const MORE_ITEM: RailItem = { key: 'more', label: 'More', short: 'More', icon: Ellipsis, action: 'more' }

/**
 * The rail for the signed-in persona — `navGroupsFor` in `src/atlas/nav.ts` is
 * the one list: its order, labels and destinations. A module the persona cannot
 * enter is absent, never greyed; "More" holds the secondary ones and is drawn
 * only when there are any. Patient search sits second, as in the old rail.
 */
/**
 * Kept off the rail: the Stroke-AI Console and the Assistant. Their screens stay —
 * the assistant is the bubble at the bottom right, the stroke screens open from
 * the patient's record and are the stroke team's own landing.
 */
const OFF_RAIL = new Set<Section>(['stroke', 'assistant'])

function useRail() {
  const persona = useSession((s) => s.persona)
  return useMemo(() => {
    const groups = navGroupsFor(persona)
    const onRail = (n: NavItem) => !OFF_RAIL.has(n.section)
    const primary = mergePatientLists(groups.primary.filter(onRail).map((n) => railItem(n, persona)))
    const more = mergePatientLists(groups.secondary.filter(onRail).map((n) => railItem(n, persona)))
    const items = [...primary.slice(0, 1), SEARCH, ...primary.slice(1), ...(more.length > 0 ? [MORE_ITEM] : [])]
    return { primary, more, items }
  }, [persona])
}

/** The rail item a path belongs to: the registry's `navSection`, with the record under Patient search. */
function useActiveKey(): RailItem['key'] | null {
  const { pathname } = useLocation()
  if (pathname === '/') return 'home'
  if (pathname.startsWith('/patient/')) return 'search'
  const section = screenForPath(pathname)?.navSection ?? null
  return section && PATIENT_LISTS.has(section) ? 'patients' : section
}

/**
 * `aria-current` for a rail link: "page" only where the link IS this page, and
 * "true" where it is the section this page sits in (a case clock under the
 * Stroke-AI Console) — so no link claims to be a page it is not.
 */
function useCurrent() {
  const { pathname } = useLocation()
  return (on: boolean, to?: string) => (!on ? undefined : to === pathname ? ('page' as const) : ('true' as const))
}

export function NavRail() {
  const open = useShri((s) => s.railOpen)
  const moreOpen = useShri((s) => s.moreOpen)
  const setMoreOpen = useShri((s) => s.setMoreOpen)
  const openSearch = useShri((s) => s.openSearch)
  // Critical results nobody has acknowledged yet — the count the Critical KPI shows.
  const critical = useClinical((s) => unacknowledgedCritical(s.acknowledgements).length > 0)
  // A patient in a video call, waiting for the doctor.
  const lobby = useWaiting((s) => Object.keys(s.waiting).length > 0)
  const active = useActiveKey()
  const current = useCurrent()
  const { items, more } = useRail()
  const onMorePage = more.some((m) => m.key === active)

  // Auto-open the nested group when on Orders or Imaging.
  useEffect(() => {
    if (onMorePage) setMoreOpen(true)
  }, [onMorePage, setMoreOpen])

  return (
    <>
      <motion.nav
        aria-label="Main"
        animate={{ width: open ? 220 : 76 }}
        transition={T220}
        className="sh-scrollbar sticky top-(--shell-pt) flex h-fit max-h-[calc(100dvh_-_var(--shell-pt)_-_var(--shell-pb))] flex-col self-start overflow-y-auto rounded-[40px] bg-sh-rail px-[13px] py-[14px] max-sm:hidden"
        style={{ width: open ? 220 : 76 }}
      >
        <ul className="flex flex-col gap-[4px]">
          {items.map((it) => {
            const isActive = it.key === active
            const label = it.title ?? it.label
            const cls = cn(
              'group relative flex w-full items-center gap-[12px] rounded-full pl-[15px] pr-[12px] text-left text-[14px] font-medium transition-colors duration-150',
              isActive ? 'mb-[6px] h-[50px] bg-sh-accent text-sh-accent-ink' : 'h-[46px] text-white/85 hover:bg-(--rail-hover) hover:text-white',
            )
            const inner = (
              <>
                <span className="relative inline-flex size-[20px] shrink-0 items-center justify-center">
                  <Icon icon={it.icon} size={20} />
                  {it.key === 'results' && critical && (
                    <span className="absolute -right-[3px] -top-[2px] size-[7px] rounded-full bg-sh-crit ring-2 ring-sh-rail" aria-hidden="true" />
                  )}
                  {it.key === 'telehealth' && lobby && (
                    <span className="absolute -right-[3px] -top-[2px] size-[7px] rounded-full bg-sh-norm ring-2 ring-sh-rail" aria-hidden="true" data-lobby-dot="" />
                  )}
                </span>
                <AnimatePresence initial={false}>
                  {open && (
                    <motion.span
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1, transition: { duration: 0.15, delay: 0.08 } }}
                      exit={{ opacity: 0, transition: { duration: 0.08 } }}
                      className="truncate"
                    >
                      {it.label}
                    </motion.span>
                  )}
                </AnimatePresence>
              </>
            )
            return (
              <li key={it.key}>
                {it.to ? (
                  <Link
                    to={it.to}
                    className={cls}
                    aria-current={current(isActive, it.to)}
                    title={label}
                    aria-label={it.key === 'results' && critical ? `${it.label}, critical results waiting` : it.key === 'telehealth' && lobby ? `${it.label}, a patient is waiting in a video call` : it.label}
                  >
                    {inner}
                  </Link>
                ) : (
                  <button
                    type="button"
                    className={cls}
                    title={label}
                    aria-label={it.label}
                    aria-current={isActive ? 'true' : undefined}
                    aria-expanded={it.action === 'more' ? moreOpen : undefined}
                    onClick={() => {
                      if (it.action === 'search') openSearch()
                      else setMoreOpen(!moreOpen)
                    }}
                  >
                    {inner}
                  </button>
                )}
                {it.action === 'more' && (
                  <AnimatePresence initial={false}>
                    {moreOpen && (
                      <motion.ul
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1, transition: T220 }}
                        exit={{ height: 0, opacity: 0, transition: { duration: 0.15 } }}
                        className="mt-[4px] overflow-hidden rounded-[22px] bg-(--rail-more)"
                      >
                        {more.map((m) => {
                          const on = m.key === active
                          return (
                            // 44px links, whole inside the group: its overflow-hidden (for the open/close) clips any hit area past
                            // it, the rounded corners included — so the first and last sit 10px in, clear of the curve.
                            <li key={m.key} className="px-[3px] py-[2px] first:pt-[10px] last:pb-[10px]">
                              <Link
                                to={m.to!}
                                title={m.label}
                                aria-label={m.label}
                                aria-current={current(on, m.to)}
                                className={cn(
                                  'flex h-[44px] items-center gap-[12px] rounded-full pl-[12px] pr-[10px] text-[14px] font-medium transition-colors duration-150',
                                  on ? 'bg-sh-accent text-sh-accent-ink' : 'text-white/85 hover:bg-(--rail-hover) hover:text-white',
                                )}
                              >
                                <Icon icon={m.icon} size={20} />
                                {open && <span className="truncate">{m.label}</span>}
                              </Link>
                            </li>
                          )
                        })}
                      </motion.ul>
                    )}
                  </AnimatePresence>
                )}
              </li>
            )
          })}
        </ul>
      </motion.nav>
      {/* Which build this is, at the bottom left as in care-entry: when it was made (India time), and its commit on hover. */}
      <p
        className="fixed bottom-[10px] left-[64px] z-10 -translate-x-1/2 text-center text-[10px]/[13px] font-medium tabular-nums text-sh-text-3 max-sm:hidden"
        title={`Build ${__BUILD_STAMP__} · commit ${__BUILD_COMMIT__}`}
      >
        Version
        <br />
        <span className="whitespace-nowrap">{__BUILD_STAMP__}</span>
      </p>
    </>
  )
}

interface Tab {
  key: string
  label: string
  icon: LucideIcon
  to?: string
}

/** Tabs kept on the bar below 360px; the rest fold into "More". */
const NARROW_TABS = 4

/**
 * §4.2 — under 768px the rail becomes a bottom tab bar, fixed to the viewport
 * and lifted above the home indicator. Every tab is at least 44px wide down to
 * 352px; below 360px the bar keeps its first four and folds the rest into a
 * "More" sheet so no tab drops under 44px.
 */
export function NavTabBar() {
  const active = useActiveKey()
  const current = useCurrent()
  const narrow = useMediaQuery('(max-width: 359.98px)')
  const [wantMore, setMoreOpen] = useState(false)
  const sheet = useRef<HTMLDivElement>(null)

  const tabs: Tab[] = useRail().primary.map((t) => ({ key: t.key, label: t.short, icon: t.icon, to: t.to }))
  const fold = narrow && tabs.length > NARROW_TABS + 1
  const shown = fold ? tabs.slice(0, NARROW_TABS) : tabs
  const folded = fold ? tabs.slice(NARROW_TABS) : []
  const moreActive = folded.some((t) => t.key === active)
  // Wider than 360px nothing is folded, so a sheet left open has nothing to show.
  const moreOpen = wantMore && fold

  const closeMore = useCallback(() => setMoreOpen(false), [])
  useOutsideClick(sheet, moreOpen, closeMore)
  useEffect(() => {
    if (!moreOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [moreOpen])

  function activate() {
    setMoreOpen(false)
  }

  return (
    <div ref={sheet} className="hidden max-sm:contents">
      <AnimatePresence>
        {moreOpen && (
          <motion.div
            key="more"
            variants={sheetUp}
            initial="hidden"
            animate="shown"
            exit="exit"
            role="menu"
            aria-label="More"
            className="fixed inset-x-0 bottom-[calc(var(--tabbar-h)_+_var(--sa-b))] z-30 rounded-t-sh-modal border-t border-sh-line bg-sh-card px-[max(12px,var(--sa-l))] pb-[8px] pt-[10px] shadow-sh-pop"
          >
            {folded.map((t) => {
              const on = t.key === active
              const cls = cn(
                'flex h-[48px] w-full items-center gap-[14px] rounded-[14px] px-[12px] text-left text-[14px] font-medium transition-colors duration-150 hover:bg-sh-hover',
                on ? 'bg-sh-accent-soft text-sh-text' : 'text-sh-text-2',
              )
              const inner = (
                <>
                  <Icon icon={t.icon} size={20} />
                  {t.label}
                </>
              )
              return t.to ? (
                <Link key={t.key} to={t.to} role="menuitem" className={cls} aria-current={current(on, t.to)} onClick={activate}>
                  {inner}
                </Link>
              ) : (
                <button key={t.key} type="button" role="menuitem" className={cls} onClick={activate}>
                  {inner}
                </button>
              )
            })}
            <p className="px-[12px] pt-[6px] text-[11px] tabular-nums text-sh-text-3" title={`Build ${__BUILD_STAMP__} · commit ${__BUILD_COMMIT__}`}>
              Version {__BUILD_STAMP__}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 flex h-[calc(var(--tabbar-h)_+_var(--sa-b))] items-stretch border-t border-sh-line bg-sh-card pb-(--sa-b) pl-(--sa-l) pr-(--sa-r)"
      >
        {shown.map((t) => (
          <TabButton key={t.key} tab={t} on={t.key === active} current={current(t.key === active, t.to)} onActivate={activate} />
        ))}
        {fold && (
          <TabButton
            tab={{ key: 'more', label: 'More', icon: Ellipsis }}
            on={moreActive}
            expanded={moreOpen}
            onActivate={() => setMoreOpen(!moreOpen)}
          />
        )}
      </nav>
    </div>
  )
}

function TabButton({
  tab,
  on,
  current,
  expanded,
  onActivate,
}: {
  tab: Tab
  on: boolean
  current?: 'page' | 'true'
  expanded?: boolean
  onActivate: () => void
}) {
  const lobby = useWaiting((s) => tab.key === 'telehealth' && Object.keys(s.waiting).length > 0)
  const cls = cn(
    'flex min-w-[44px] flex-1 flex-col items-center justify-center gap-[3px] rounded-[12px] text-[10px] font-medium',
    on ? 'text-sh-text' : 'text-sh-text-3',
  )
  const inner = (
    <>
      <span className={cn('relative inline-flex h-[26px] w-[40px] items-center justify-center rounded-full', on && 'bg-sh-accent text-sh-accent-ink')}>
        <Icon icon={tab.icon} size={18} />
        {lobby && <span className="absolute right-[6px] top-[1px] size-[7px] rounded-full bg-sh-norm ring-2 ring-sh-card" aria-hidden="true" />}
      </span>
      <span className="max-w-full truncate px-[2px]">{tab.label}</span>
    </>
  )
  return tab.to ? (
    <Link to={tab.to} className={cls} aria-current={current} aria-label={tab.label} onClick={onActivate}>
      {inner}
    </Link>
  ) : (
    <button
      type="button"
      className={cls}
      onClick={onActivate}
      aria-label={tab.label}
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : 'menu'}
    >
      {inner}
    </button>
  )
}
