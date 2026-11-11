import { NavLink } from 'react-router-dom'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { cn } from '../../utils/cn'
import { TONE_HEX } from '../../utils/toneHex'
import { useSidebar } from '../../hooks/useSidebar'
import { BrandMark } from './BrandMark'
import { NAV_GROUPS } from './navigation'
import { NavCount } from './NavCount'
import { useNavBadges } from '../../hooks/useNavBadges'

/**
 * The app's navigation from 768px up (DESIGN_SYSTEM §8.3 item states: the
 * glyph tinted in its place's hue, the active place in the primary wash).
 *
 *   ≥ 1024px  a full 240px sidebar that collapses to a 64px icon rail —
 *             the choice is remembered
 *   768–1023  always the icon rail
 *   < 768     hidden; the same places are the phone nav row (MobileNavRow)
 *
 * In the rail every label is the item's tooltip and accessible name.
 */
export function Sidebar() {
  const { expanded, isDesktop, toggle } = useSidebar()
  const badges = useNavBadges()

  return (
    <aside
      data-expanded={expanded}
      className={cn(
        'hidden h-full shrink-0 flex-col border-r border-border-soft bg-surface-1 transition-[width] duration-200 ease-out md:flex print:hidden',
        // A faint wash of colour, blue at the top to violet at the foot.
        'bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-hue-blue)_6%,var(--color-surface-1))_0%,var(--color-surface-1)_38%,var(--color-surface-1)_62%,color-mix(in_oklab,var(--color-hue-violet)_6%,var(--color-surface-1))_100%)]',
        expanded ? 'w-60' : 'w-16',
      )}
    >
      {/* The SHRI HEALTH mark (back to the SHRI apps home), with collapse /
          expand beside it — desktop only; the tablet rail has no room to open. */}
      <div className={cn('flex h-16 shrink-0 items-center border-b border-border-soft', expanded ? 'gap-1 pl-2 pr-2' : 'justify-center px-2')}>
        <a
          href="https://shri-ai.org"
          aria-label="SHRI HEALTH Care Entry — shri-ai.org"
          title="SHRI HEALTH"
          className={cn(
            'focus-ring flex min-w-0 items-center gap-2.5 rounded-lg py-1.5 transition-colors hover:bg-surface-2',
            expanded ? 'flex-1 justify-start px-2' : 'justify-center px-1.5',
          )}
        >
          <BrandMark className="h-8" />
          {expanded ? (
            <span className="min-w-0">
              <span className="block whitespace-nowrap text-[15px] font-bold uppercase leading-tight tracking-[0.06em] text-ink">SHRI Health</span>
              <span className="block text-xs font-medium leading-tight text-ink-subtle">Care Entry</span>
            </span>
          ) : null}
        </a>
        {isDesktop && expanded ? <CollapseButton expanded onToggle={toggle} /> : null}
      </div>
      {isDesktop && !expanded ? (
        <div className="flex shrink-0 justify-center border-b border-border-soft py-2">
          <CollapseButton expanded={false} onToggle={toggle} />
        </div>
      ) : null}

      <nav aria-label="Main navigation" className={cn('scrollbar-hide flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-3', expanded ? 'px-2.5' : 'px-2')}>
        {NAV_GROUPS.map((group, index) => (
          <div key={group.label ?? `places-${index}`}>
            {group.label ? (
              expanded ? (
                <p className="px-2.5 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-subtle">{group.label}</p>
              ) : (
                <div role="separator" className="mx-2 mb-2.5 h-px bg-border-soft" />
              )
            ) : null}
            <ul className="flex flex-col gap-0.5">
              {group.items.map(({ path, label, icon: Icon, end, hue }) => {
                const badge = badges[path]
                return (
                <li key={path}>
                  <NavLink
                    to={path}
                    end={end}
                    title={expanded ? undefined : badge ? `${label} — ${badge.label}` : label}
                    aria-label={expanded ? undefined : badge ? `${label}, ${badge.label}` : label}
                    className={({ isActive }) =>
                      cn(
                        'group focus-ring flex w-full items-center gap-2.5 rounded-lg text-sm font-medium transition-colors',
                        isDesktop ? 'min-h-10' : 'min-h-11',
                        expanded ? 'justify-start px-2.5' : 'justify-center px-0',
                        'relative',
                        isActive
                          ? cn(
                              'bg-primary-50 font-semibold text-primary-text shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary-500)_18%,transparent)]',
                              // A short gradient bar at the leading edge marks the current place.
                              expanded && 'before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-[image:var(--gradient-primary)]',
                            )
                          : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <Icon
                          size={expanded ? 17 : 19}
                          strokeWidth={isActive ? 2.2 : 1.8}
                          aria-hidden="true"
                          className="shrink-0 transition-transform duration-150 group-hover:scale-105"
                          style={{ color: TONE_HEX[hue] }}
                        />
                        {expanded ? <span className="min-w-0 flex-1 truncate">{label}</span> : null}
                        {badge ? (
                          expanded ? (
                            <>
                              <NavCount badge={badge} />
                              <span className="sr-only">, {badge.label}</span>
                            </>
                          ) : (
                            <NavCount badge={badge} dot />
                          )
                        ) : null}
                        {isActive ? <span className="sr-only">(current page)</span> : null}
                      </>
                    )}
                  </NavLink>
                </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Which version this is: V_ day month - that day's number (India time); its commit on hover. */}
      {expanded ? (
        <div className="shrink-0 border-t border-border-soft px-2.5 py-2">
          <p className="px-2.5 pb-1 pt-1 text-2xs font-medium tabular-nums tracking-wide text-ink-subtle" title={`Version ${__BUILD_STAMP__} · commit ${__BUILD_COMMIT__}`}>
            {__BUILD_STAMP__}
          </p>
        </div>
      ) : null}
    </aside>
  )
}

function CollapseButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const label = expanded ? 'Collapse sidebar' : 'Expand sidebar'
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
    >
      {expanded ? <PanelLeftClose size={18} aria-hidden="true" /> : <PanelLeftOpen size={19} aria-hidden="true" />}
    </button>
  )
}
