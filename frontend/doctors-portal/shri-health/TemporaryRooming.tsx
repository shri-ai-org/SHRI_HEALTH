// TEMPORARY — no source screen (frontend/docs/SCREEN_PORT.md). The doctors' portal has no rooming
// screen, so demo step 6 opens main's RoomingPage here, as the front office does
// (front-office/shri-health/TemporaryRoutes.tsx), until Minalini decides after the demo. Delete this
// file, temporary-rooming.css, roomingOf() in opd.ts, the Room buttons in OpdQueuePage.tsx and the two
// TEMPORARY routes in src/shri/ShriApp.tsx together.
import { useLayoutEffect } from 'react'
import { Navigate } from 'react-router-dom'

import { ToastProvider } from '../../src/design-system'
import { RoomingPage } from '../../src/features/clinical/RoomingPage'
import { forgetAll } from './resource'
import css from './temporary-rooming.css?inline'

/** The shared design system's styles, only while the screen is open: the portal keeps its own look everywhere else.
 *  Leaving the screen also forgets what the portal had read, since rooming changed it. */
function useScreenStyles() {
  useLayoutEffect(() => {
    const style = document.createElement('style')
    style.dataset.temporary = 'rooming'
    style.textContent = css
    document.head.append(style)
    return () => {
      style.remove()
      // Rooming wrote vitals, allergies and the visit's status: the portal's screens read them again.
      forgetAll()
    }
  }, [])
}

/** Demo step 6: rooming (`/temporary/rooming/:encounterId`), opened from the OPD queue's Room button. */
export function TemporaryRooming() {
  useScreenStyles()
  return (
    <ToastProvider>
      <main className="mx-auto w-full max-w-6xl px-4 py-6">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">TEMPORARY — no source screen · demo step 6, room</p>
        <RoomingPage />
      </main>
    </ToastProvider>
  )
}

/** RoomingPage's "back" link goes to main's /today; here that is the OPD queue. */
export function TemporaryToday() {
  return <Navigate to="/op-queue" replace />
}
