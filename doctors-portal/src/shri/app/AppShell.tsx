/**
 * The app surface, edge to edge. It fills the viewport on every device — no
 * page padding, no bezel, no outer radius — and the page backdrop paints the
 * canvas behind it (see `html.shri-active` in tokens.css). Its padding (§3.4:
 * 22 / 26, 16 at the sides on a phone) folds in the safe-area insets, so
 * nothing lands under a notch or the home indicator.
 *
 * `overflow-x: clip`, not `hidden`: nothing can push the page sideways, and it
 * makes no scroll container, so the rail's `sticky` still sticks. Drawers,
 * modals, the toast, the tab bar and the assistant bubble are `fixed` to the
 * viewport. The content row caps at 1920px on ultrawide screens; the surface
 * behind it still runs the full width.
 */

import { AnimatePresence } from 'framer-motion'
import { useCallback } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'

import { useAdmissionService } from '@/api/admissions'

import { selectScrim, useShri } from '../state/store'
import { Scrim } from '../ui/Scrim'

import { useRoomWatch } from '../telehealth/roomWatch'
import { useWaitingAlerts } from '../telehealth/waitingAlerts'
import { WaitingBar } from '../telehealth/WaitingBar'

import { AppBar } from './AppBar'
import { AssistantBubble } from './AssistantBubble'
import { AssistantDrawer } from './AssistantDrawer'
import { NavRail, NavTabBar } from './NavRail'
import { OverlayHost } from './OverlayHost'
import { RouteBoundary } from './RouteBoundary'

export function AppShell() {
  // The front office, simulated: allocates the bed and completes each admission as its step falls due (`@/api/admissions`).
  useAdmissionService()
  const railOpen = useShri((s) => s.railOpen)
  const scrimOn = useShri(selectScrim)
  const closeTop = useShri((s) => s.closeTop)
  const { pathname } = useLocation()
  const navigate = useNavigate()
  // A patient waiting in a video call: asked of the hospital's Jitsi, announced with a chime and a notice on this computer.
  useRoomWatch()
  useWaitingAlerts(useCallback((visitId: string) => navigate(`/tele/session/${visitId}`, { state: { join: true } }), [navigate]))

  return (
    <div className="min-h-dvh w-full overflow-x-clip bg-sh-surface pb-(--shell-pb) pl-[max(26px,var(--sa-l))] pr-[max(26px,var(--sa-r))] pt-(--shell-pt) max-sm:pb-[calc(var(--tabbar-h)_+_16px_+_var(--sa-b))] max-sm:pl-[max(16px,var(--sa-l))] max-sm:pr-[max(16px,var(--sa-r))]">
      <div className="mx-auto w-full max-w-[1920px]">
        <AppBar />

        <div
          className="mt-[18px] grid gap-[20px] max-sm:block"
          style={{ gridTemplateColumns: `${railOpen ? 220 : 76}px minmax(0, 1fr)` }}
        >
          <NavRail />
          <main className="min-w-0">
            <RouteBoundary resetKey={pathname}>
              <Outlet />
            </RouteBoundary>
          </main>
        </div>
      </div>

      <NavTabBar />

      {/* One scrim for every scrim-backed overlay; clicking it closes the top one. */}
      <AnimatePresence>
        {scrimOn && <Scrim key="scrim" onClick={closeTop} className="z-40" />}
      </AnimatePresence>

      {/* A patient waiting in a video call: a floating alert over every screen until the doctor joins. */}
      <WaitingBar />
      <OverlayHost />
      <AssistantDrawer />
      <AssistantBubble />
    </div>
  )
}
