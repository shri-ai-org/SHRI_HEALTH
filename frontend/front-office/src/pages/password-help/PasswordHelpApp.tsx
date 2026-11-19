// The public "Forgot password?" pages, rendered outside the session (main.tsx), so they open before
// anyone signs in. Real builds use the handlers that aren't connected yet (no contract on main), so
// they show "unavailable" rather than anything made up; development mock builds get a preview bar to
// show every state.
import { useMemo } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { REAL_API } from '../../../shri-health/client'
import { notYetConnected, PASSWORD_HELP_PATH, PASSWORD_HELP_STATUS_PATH, type PasswordHelpHandlers } from '../../../shri-health/passwordHelp'
import { PreviewBar, previewHandlers } from './preview'
import { RequestPage } from './RequestPage'
import { StatusPage } from './StatusPage'

export function PasswordHelpRoutes({ handlers, signInHref }: { handlers: PasswordHelpHandlers; signInHref: string }) {
  return (
    <Routes>
      <Route path={PASSWORD_HELP_PATH} element={<RequestPage handlers={handlers} signInHref={signInHref} />} />
      <Route path={PASSWORD_HELP_STATUS_PATH} element={<StatusPage handlers={handlers} signInHref={signInHref} />} />
      <Route path="*" element={<Navigate to={PASSWORD_HELP_PATH} replace />} />
    </Routes>
  )
}

export function PasswordHelpApp() {
  const basename = import.meta.env.BASE_URL.replace(/\/$/, '')
  // The app's own root: it starts the normal sign-in.
  const signInHref = `${basename}/`
  const handlers = useMemo(() => (REAL_API ? notYetConnected : previewHandlers()), [])
  return (
    <BrowserRouter basename={basename}>
      <PasswordHelpRoutes handlers={handlers} signInHref={signInHref} />
      {REAL_API ? null : <PreviewBar />}
    </BrowserRouter>
  )
}
