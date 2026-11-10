/**
 * §4.1 — the app bar. 56px, left → right, gap 12px. Dark: every control on
 * `--card` with white icons, which the tokens already do.
 *
 * On a phone (< 768px) it has to fit 288px: the rail toggle goes (there is no
 * rail — the tab bar replaces it), gaps close to 8px, the Indostates logo at
 * the far right shrinks (and goes under 420px), and the user pill drops its
 * chevron (it still opens its menu). Under 360px the theme toggle moves into
 * the user menu.
 */

import { Bell, ChevronDown, Menu as MenuIcon, Moon, Search, Sun, UserRound } from 'lucide-react'

import { LANGUAGES, type LanguageCode } from '@/data/kit'
import { useCurrentStaff, useSession } from '@/store/session'

import { cn } from '../lib/cn'
import { useShri } from '../state/store'
import { Icon, RoundButton } from '../ui/primitives'

import { Logo } from './Logo'
import indostatesLogoDark from './indostates-logo-dark.webp'
import indostatesLogo from './indostates-logo.webp'
import { NotificationsMenu } from './menus/NotificationsMenu'
import { useNotices } from './menus/useNotices'
import { UserMenu } from './menus/UserMenu'

export function AppBar() {
  const toggleRail = useShri((s) => s.toggleRail)
  const railOpen = useShri((s) => s.railOpen)
  const theme = useShri((s) => s.theme)
  const toggleTheme = useShri((s) => s.toggleTheme)
  const language = useSession((s) => s.language)
  const setLanguage = useSession((s) => s.setLanguage)
  const me = useCurrentStaff()
  const menu = useShri((s) => s.menu)
  const toggleMenu = useShri((s) => s.toggleMenu)
  const openSearch = useShri((s) => s.openSearch)
  const unread = useNotices().inbox.length

  return (
    <header className="flex h-[56px] items-center gap-[12px] max-sm:gap-[6px]" role="banner">
      <RoundButton
        icon={MenuIcon}
        label={railOpen ? 'Collapse navigation' : 'Expand navigation'}
        variant="card"
        size={48}
        iconSize={20}
        aria-expanded={railOpen}
        onClick={toggleRail}
        className="max-sm:hidden"
      />

      <Logo />

      <div className="flex-1" />

      <RoundButton icon={Search} label="Patient search" variant="card" size={48} iconSize={20} className="max-sm:size-[44px] sm:hidden" onClick={openSearch} />

      <RoundButton
        icon={theme === 'light' ? Moon : Sun}
        label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
        variant="card"
        size={48}
        iconSize={20}
        onClick={toggleTheme}
        className="max-sm:size-[44px] max-[360px]:hidden"
      />

      <div className="relative">
        <RoundButton
          icon={Bell}
          label={`Notifications, ${unread} unread`}
          variant="card"
          size={48}
          iconSize={20}
          aria-haspopup="menu"
          aria-expanded={menu === 'notifications'}
          onClick={() => toggleMenu('notifications')}
          className="max-sm:size-[44px]"
        />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -right-[2px] -top-[2px] inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-sh-card bg-sh-crit px-[4px] text-[11px]/none font-semibold text-white"
          >
            {unread}
          </span>
        )}
        <NotificationsMenu />
      </div>

      <label className="relative max-sm:hidden">
        <span className="sr-only">Interface language</span>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value as LanguageCode)}
          title="Interface language — patient documents follow the patient's preference, not this"
          className={cn(
            'h-[48px] cursor-pointer appearance-none rounded-full bg-sh-card pl-[16px] pr-[36px] text-[14px] font-medium text-sh-text transition-colors duration-150 hover:bg-sh-hover',
          )}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        <Icon icon={ChevronDown} size={16} className="pointer-events-none absolute right-[12px] top-1/2 -translate-y-1/2 text-sh-chev" />
      </label>

      <div className="relative">
        <button
          type="button"
          onClick={() => toggleMenu('user')}
          aria-haspopup="menu"
          aria-expanded={menu === 'user'}
          aria-label={`${me.name} — user menu`}
          className="flex h-[48px] items-center gap-[10px] rounded-full bg-sh-card pl-[4px] pr-[12px] text-sh-text transition-colors duration-150 hover:bg-sh-hover max-sm:h-[44px] max-sm:pr-[4px]"
        >
          <span className="inline-flex size-[40px] items-center justify-center rounded-full bg-sh-primary text-sh-on-primary">
            <Icon icon={UserRound} size={20} />
          </span>
          <span className="whitespace-nowrap text-[14px] font-semibold max-md:hidden">{me.name}</span>
          <Icon icon={ChevronDown} size={16} className="text-sh-chev max-sm:hidden" />
        </button>
        <UserMenu />
      </div>

      {/* The hospital's own mark, far right, linking to its site. Two copies: the dark theme's lifts the grey lettering. Under 420px the row has no room for it. */}
      <a
        href="https://indostates.com"
        title="Indostates Health — indostates.com"
        className="flex h-[48px] shrink-0 items-center rounded-full px-[8px] transition-colors duration-150 hover:bg-sh-hover max-sm:h-[44px] max-sm:px-[4px] max-[420px]:hidden"
      >
        <img src={indostatesLogo} width={175} height={36} alt="Indostates Health — go to indostates.com" decoding="async" className="h-[36px] w-auto shdark:hidden max-sm:h-[26px]" />
        <img src={indostatesLogoDark} width={175} height={36} alt="Indostates Health — go to indostates.com" decoding="async" className="hidden h-[36px] w-auto shdark:block max-sm:h-[26px]" />
      </a>
    </header>
  )
}
