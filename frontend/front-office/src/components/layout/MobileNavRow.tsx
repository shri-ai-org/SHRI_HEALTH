import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { Languages } from 'lucide-react'
import { cn } from '../../utils/cn'
import { NavCount } from './NavCount'
import { useNavBadges } from '../../hooks/useNavBadges'
import { TONE_HEX } from '../../utils/toneHex'
import { LANGUAGES, setLanguage, useLanguage } from '../../hooks/useLanguage'
import type { LanguageCode } from '../../hooks/useLanguage'
import { NAV_ITEMS, isActivePath } from './navigation'

/**
 * Phones (< 768px): every place in one compact row under the app bar that
 * scrolls sideways — nothing is pinned over the bottom of the page. The
 * current place is the filled pill and is kept in view; a soft fade on
 * whichever side has more shows the row scrolls. A horizontal swipe
 * scrolls the row; a vertical one still scrolls the page.
 */
export function MobileNavRow() {
  const { pathname } = useLocation()
  const row = useRef<HTMLUListElement>(null)
  const [edges, setEdges] = useState({ start: false, end: true })
  const languageCode = useLanguage()
  const badges = useNavBadges()

  const measure = useCallback(() => {
    const el = row.current
    if (!el) return
    const start = el.scrollLeft > 4
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
    setEdges((current) => (current.start === start && current.end === end ? current : { start, end }))
  }, [])

  // Bring the current place into view whenever the route changes.
  useEffect(() => {
    const el = row.current
    const active = el?.querySelector<HTMLElement>('[aria-current="page"]')
    if (el && active) {
      const target = active.offsetLeft - el.clientWidth / 2 + active.offsetWidth / 2
      el.scrollTo({ left: Math.max(0, target), behavior: 'smooth' })
    }
    measure()
  }, [pathname, measure])

  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  const fade = `linear-gradient(to right, ${edges.start ? 'transparent 0, #000 1.5rem' : '#000 0'}, ${edges.end ? '#000 calc(100% - 1.75rem), transparent 100%' : '#000 100%'})`

  return (
    <nav aria-label="Main navigation" className="border-t border-border-soft md:hidden print:hidden">
      <ul
        ref={row}
        onScroll={measure}
        style={{ WebkitMaskImage: fade, maskImage: fade } as CSSProperties}
        className="scrollbar-hide flex snap-x scroll-px-4 items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain px-4 py-2"
      >
        {NAV_ITEMS.map(({ path, label, icon: Icon, end, hue }) => {
          const active = isActivePath({ path, end }, pathname)
          const badge = badges[path]
          return (
            <li key={path} className="shrink-0 snap-start">
              <NavLink
                to={path}
                end={end}
                className={cn(
                  'focus-ring tap-reach flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-semibold transition-all duration-200 active:scale-[0.97]',
                  active
                    ? 'border-transparent bg-[image:var(--gradient-primary)] text-on-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_4px_12px_-4px_rgba(37,99,235,0.5)]'
                    : 'border-border-soft bg-surface-1 text-ink-muted shadow-card-sm hover:text-ink',
                )}
              >
                <Icon size={15} strokeWidth={active ? 2.2 : 1.9} aria-hidden="true" style={active ? undefined : { color: TONE_HEX[hue] }} />
                {label}
                {badge ? (
                  <>
                    {active ? (
                      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-white/25 px-1.5 text-2xs font-bold tabular-nums">{badge.count}</span>
                    ) : (
                      <NavCount badge={badge} />
                    )}
                    <span className="sr-only">, {badge.label}</span>
                  </>
                ) : null}
              </NavLink>
            </li>
          )
        })}
        {/* Language — a native picker, so it works inside the scrolling row. */}
        <li className="ml-1 shrink-0 snap-start border-l border-border-soft pl-2.5">
          <label className="relative flex h-9 items-center gap-1.5 rounded-full border border-border-soft bg-surface-1 pl-3 pr-2 text-xs font-semibold text-ink-muted shadow-card-sm focus-within:ring-2 focus-within:ring-focus/40">
            <Languages size={15} aria-hidden="true" />
            <span className="sr-only">Language</span>
            <select
              value={languageCode}
              onChange={(event) => setLanguage(event.target.value as LanguageCode)}
              className="-my-1 h-11 min-h-0 appearance-none bg-transparent pr-1 text-xs font-semibold text-ink-muted outline-none"
              style={{ fontSize: 'max(16px, 1em)' }}
            >
              {LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </select>
          </label>
        </li>
      </ul>
    </nav>
  )
}
