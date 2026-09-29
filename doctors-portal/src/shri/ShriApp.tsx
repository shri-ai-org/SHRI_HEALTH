/**
 * Shri Health — the whole app, at the root. Every routed screen in the
 * registry (`src/atlas/registry.ts`) keeps the address, `:id` and query the
 * old build used, so its deep links still open. Two screens moved to a
 * shorter address: My Day is `/`, the record overview is `/patient/:id`; their
 * old addresses make one `replace` hop.
 *
 * There is no sign-in: the portal opens straight on the doctor's dashboard,
 * My Day. An old `/login` link (with or without `?next=`) makes one hop to
 * where it was going. Each screen still checks the persona's capability
 * against its own `permission` — a screen the persona cannot use shows the
 * refusal, whatever the reason.
 */

import { MotionConfig } from 'framer-motion'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { ROUTED_SCREENS, isBare, screen, type ScreenSpec } from '@/atlas/registry'
import { useSession } from '@/store/session'

import { AppShell } from './app/AppShell'
import { landingFor, mayOpen } from './app/landing'
import { NightPrompt } from './app/NightPrompt'
import { canonical } from './app/paths'
import { RouteBoundary } from './app/RouteBoundary'
import { Toast } from './app/Toast'
import { useShriKeys } from './lib/useShriKeys'
import { MyDayPage } from './myday/MyDayPage'
import { RecordPage } from './record/RecordPage'
import { Denied } from './screens/Denied'
import { NotFound } from './screens/NotFound'
import { OWN_STATES, SCREEN_COMPONENTS } from './screens/registry'
import { forceState, useForcedState } from './state/ai'
import { useShri } from './state/store'
import { ErrorFrame } from './ui/states'

/** Screens whose old address now makes one hop to a new one. */
const MOVED = new Set(['S-06-01', 'S-06-11'])
/** The command wall draws no shell (`isBare`). Sign-in is bare too, and the one public route. */
const BARE = ROUTED_SCREENS.filter((s) => isBare(s) && s.permission !== 'public')
const SHELLED = ROUTED_SCREENS.filter((s) => !isBare(s) && !MOVED.has(s.id))
const MY_DAY = screen('S-06-01')
const RECORD = screen('S-06-11')

/**
 * The screen or its refusal — decided on every request.
 * A forced DENIED replaces the drawn screen whole: it shows no patient data
 * anywhere, not even the banner (`src/shell/Screen.tsx:182-190`). A forced
 * ERROR does too, unless the screen draws the old frame's states itself.
 */
function Screen({ spec, element }: { spec: ScreenSpec; element?: ReactNode }) {
  const persona = useSession((s) => s.persona)
  const forced = useForcedState()
  const Drawn = SCREEN_COMPONENTS[spec.id]
  const drawn = element !== undefined || Drawn !== undefined
  if (!mayOpen(persona, spec.permission)) return <Denied capability={spec.permission} screenId={drawn ? spec.id : undefined} />
  // Every routed screen is drawn now; a registry entry without a component would be a build defect, not a screen in transit.
  if (!drawn) return <NotFound />
  if (forced === 'DENIED') return <Denied capability={spec.permission} screenId={spec.id} />
  if (forced === 'ERROR' && !OWN_STATES.has(spec.id)) {
    return (
      <div className="mx-auto w-full max-w-[640px] py-[40px]" data-screen-id={spec.id}>
        <ErrorFrame />
      </div>
    )
  }
  return (
    <>
      <NightPrompt spec={spec} />
      {element ?? (Drawn && <Drawn />)}
    </>
  )
}

/** My Day, or — for a persona without it (P-13, P-38) — one hop to where they land. */
function Home() {
  const persona = useSession((s) => s.persona)
  const { search, hash } = useLocation()
  if (!mayOpen(persona, MY_DAY.permission)) {
    const to = landingFor(persona)
    if (to !== '/') return <Navigate replace to={`${to}${search}${hash}`} />
  }
  return <Screen spec={MY_DAY} element={<MyDayPage />} />
}

/** The one hop from an old address to its new one, keeping the query and the hash. */
function Moved() {
  const { pathname, search, hash } = useLocation()
  return <Navigate replace to={`${canonical(pathname)}${search}${hash}`} />
}

/** The old sign-in address: one hop to where it was going (`?next=`), or to My Day. */
function NoSignIn() {
  const { search } = useLocation()
  const next = new URLSearchParams(search).get('next')
  return <Navigate replace to={next && next.startsWith('/') && !next.startsWith('//') ? next : '/'} />
}

export default function ShriApp() {
  const theme = useShri((s) => s.theme)

  // The theme lives on <html data-theme> (§3), so the page backdrop follows it.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useShriKeys()

  // A forced state belongs to the screen it was forced on: the old build clears it
  // whenever the screen changes (`src/shell/Screen.tsx:162`), and so does this one.
  const { pathname } = useLocation()
  const shownAt = useRef(pathname)
  useEffect(() => {
    if (shownAt.current === pathname) return
    shownAt.current = pathname
    forceState(null)
  }, [pathname])

  return (
    <MotionConfig reducedMotion="user">
      <div className="shri-root">
        <RouteBoundary resetKey={pathname}>
          <Routes>
            <Route path="/login" element={<NoSignIn />} />
            <Route>
              {BARE.map((s) => (
                <Route key={s.id} path={s.route!} element={<Screen spec={s} />} />
              ))}
              {/* Outside the shell, so the hop paints nothing on the way. */}
              <Route path="/clinician" element={<Moved />} />
              <Route path="/patient/:id/record" element={<Moved />} />
              <Route element={<AppShell />}>
                <Route index element={<Home />} />
                <Route path="/patient/:id" element={<Screen spec={RECORD} element={<RecordPage />} />} />
                {SHELLED.map((s) => (
                  <Route key={s.id} path={s.route!} element={<Screen spec={s} />} />
                ))}
                <Route path="*" element={<NotFound />} />
              </Route>
            </Route>
          </Routes>
        </RouteBoundary>
        {/* Mounted once, above every route, so a toast shows on the bare screens too. */}
        <Toast />
      </div>
    </MotionConfig>
  )
}
