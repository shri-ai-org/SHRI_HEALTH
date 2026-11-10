import type { Ref } from 'react'
import { useLocation } from 'react-router-dom'
import { UserMenu } from './UserMenu'
import { LanguageSwitcher } from './LanguageSwitcher'
import { ThemeToggle } from './ThemeToggle'
import { LiveClock } from './LiveClock'
import { BrandMark } from './BrandMark'
import { MobileNavRow } from './MobileNavRow'
import { PatientSearch } from '../patient/PatientSearch'
import { readFlow } from '../../flows/flowParams'
import logo115 from '../../assets/indostates-logo-115w.png'
import logo144 from '../../assets/indostates-logo-144w.png'
import logo230 from '../../assets/indostates-logo-230w.png'
import logo287 from '../../assets/indostates-logo-287w.png'
import logo345 from '../../assets/indostates-logo-345w.png'
import logo431 from '../../assets/indostates-logo-431w.png'

// The IndoStates artwork pre-rendered at the exact sizes it is shown (1×–3×,
// trimmed and sharpened), so its fine lettering stays crisp instead of being
// shrunk ~5× by the browser from one large file.
const LOGO_SRCSET = `${logo115} 115w, ${logo144} 144w, ${logo230} 230w, ${logo287} 287w, ${logo345} 345w, ${logo431} 431w`

/** Pages with their own patient field — the app-bar search steps aside there,
 *  so a screen never shows two search boxes. */
const OWN_PATIENT_FIELD = new Set(['/services/guest-pass', '/services/mlc', '/services/enquiry'])

// GP-01 — the app bar (DESIGN_SYSTEM §8.2), on every Front Office screen:
// the brand (phones only — from 768px it heads the sidebar), the patient
// search, then theme, language, notifications, the signed-in user and the
// IndoStates logo (an external link).
export function AppBar({ ref }: { ref?: Ref<HTMLElement> }) {
  const { pathname, search } = useLocation()
  // One search box per screen: a task panel brings its own patient search,
  // and so do the service pages above.
  const showSearch = readFlow(search) === null && !OWN_PATIENT_FIELD.has(pathname)

  return (
    <header
      ref={ref}
      className="sticky top-0 z-30 shrink-0 border-b border-border-soft bg-surface-1/80 shadow-[0_1px_0_0_var(--surface-highlight)_inset] backdrop-blur-xl backdrop-saturate-150 print:hidden"
    >
      <div className="flex min-h-14 flex-wrap items-center gap-x-1.5 gap-y-1.5 px-4 py-1.5 min-[360px]:gap-x-2.5 sm:min-h-16 sm:gap-y-2 sm:px-5 sm:py-2.5 xl:px-6 xl:flex-nowrap xl:gap-4 xl:py-0">
        <a href="https://shri-ai.org" aria-label="SHRI HEALTH Care Entry — shri-ai.org" className="focus-ring -ml-1 flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-1 md:hidden">
          <BrandMark className="h-7 sm:h-8" />
          <span className="hidden whitespace-nowrap text-[15px] font-bold uppercase tracking-[0.06em] text-ink sm:inline">SHRI Health</span>
          <span aria-hidden="true" className="hidden text-ink-subtle sm:inline">
            /
          </span>
          <span className="hidden whitespace-nowrap text-sm font-medium text-ink-subtle sm:inline">Care Entry</span>
        </a>

        {/* The patient search, with Register beside it — hidden while a panel or
            page has its own. Until the bar is wide enough for one row, it takes
            its own full-width row under the icons. */}
        {showSearch ? (
          <div className="order-last flex w-full min-w-0 xl:order-none xl:w-auto xl:flex-1">
            <PatientSearch mode="navigate" />
          </div>
        ) : (
          <div className="hidden xl:block xl:flex-1" aria-hidden="true" />
        )}

        <div className="ml-auto flex min-w-0 items-center gap-0.5 min-[360px]:gap-1.5 xl:ml-0">
          <LiveClock className="mr-1 max-[359px]:hidden" />
          <ThemeToggle />
          <div className="hidden sm:flex">
            <LanguageSwitcher />
          </div>
          <UserMenu />

          {/* IndoStates — an external link, opened in a new tab so the portal stays
              open. The artwork is dark-on-white, so it always sits on a white tile
              (a fixed colour on purpose: it must not follow the dark theme). */}
          <a
            href="https://indostates.com"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="IndoStates (opens indostates.com in a new tab)"
            className="focus-ring ml-0.5 flex h-11 shrink-0 items-center rounded-lg bg-[#fff] px-2 shadow-card-sm ring-1 ring-border-soft sm:ml-1 sm:px-2.5"
          >
            <img
              src={logo144}
              srcSet={LOGO_SRCSET}
              sizes="(min-width: 40rem) 144px, (min-width: 22.5rem) 115px, 96px"
              alt="IndoStates Health"
              width={144}
              height={30}
              decoding="async"
              className="h-5 w-auto object-contain min-[360px]:h-6 sm:h-[30px]"
            />
          </a>
        </div>
      </div>
      <MobileNavRow />
    </header>
  )
}
