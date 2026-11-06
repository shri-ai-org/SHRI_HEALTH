import { useEffect, useRef } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from '../components/layout/Sidebar'
import { AppBar } from '../components/layout/AppBar'
import { pageTitleFor } from '../components/layout/navigation'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { FlowHost } from '../flows/FlowHost'
import { BillingCounterNotices } from '../components/payment/BillingCounterNotices'
import { PaymentHoldSweeper } from '../components/payment/PaymentHoldSweeper'
import { AutoDischargeWatcher } from '../components/payment/AutoDischargeWatcher'
import { AbhaScannerListener } from '../components/patient/AbhaScannerListener'

/**
 * The app shell (DESIGN_SYSTEM §8, with this portal's sidebar):
 *   ≥ 1024px  full sidebar · app bar · page
 *   768–1023  72px icon rail · app bar · page
 *   < 768     app bar (with a sideways-scrolling row of every place) · page
 * The page scrolls inside <main>; the shell itself never scrolls sideways.
 */
export function AppLayout() {
  const { pathname } = useLocation()
  const headerRef = useRef<HTMLElement>(null)

  // `${pageTitle} · SHRI HEALTH` (§8.4).
  useEffect(() => {
    document.title = `${pageTitleFor(pathname)} · SHRI HEALTH`
  }, [pathname])

  // The app bar wraps onto two rows below 1280px; menus that pin themselves
  // under it on phones read its real height from --app-header-h.
  useEffect(() => {
    const header = headerRef.current
    if (!header) return undefined
    const root = document.documentElement
    const observer = new ResizeObserver(() => root.style.setProperty('--app-header-h', `${header.getBoundingClientRect().height}px`))
    observer.observe(header)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="flex h-dvh overflow-hidden text-ink" data-density="compact">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <AppBar ref={headerRef} />
        <main id="main-content" tabIndex={-1} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden focus:outline-none">
          {/* pb clears the home indicator on phones. */}
          <div className="app-content mx-auto w-full max-w-[112rem] px-4 pt-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] sm:px-5 sm:pt-5 md:pb-6 xl:px-6">
            {/* Keyed on the path: moving to another place clears a failed one. */}
            <ErrorBoundary key={pathname} scope="page">
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
      </div>

      {/* Schedule / reschedule / billing / admit / discharge open here, over the page. */}
      <FlowHost />
      <BillingCounterNotices />
      <PaymentHoldSweeper />
      <AutoDischargeWatcher />
      <AbhaScannerListener />
    </div>
  )
}
