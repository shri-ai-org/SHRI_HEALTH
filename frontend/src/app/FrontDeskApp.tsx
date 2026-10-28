import { LogOut } from 'lucide-react'
import { createBrowserRouter, Navigate, NavLink, Outlet, RouterProvider, type RouteObject } from 'react-router'
import { SessionProvider, useSession } from '../api/session'
import { Button } from '../design-system'
import { PatientPage } from '../features/patients/PatientPage'
import { PatientSearchPage } from '../features/patients/PatientSearchPage'
import { RegisterPatientPage } from '../features/patients/RegisterPatientPage'
import { RegisterPrefillProvider } from '../features/patients/registerPrefill'
import { SchedulePage } from '../features/scheduling/SchedulePage'
import { DesignSystemPreview } from './DesignSystemPreview'

const navClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-primary-50 text-primary-700' : 'text-ink-muted hover:text-ink'}`

/** Header, navigation and page area for signed-in front-desk staff. */
function Shell() {
  const { state, signOut } = useSession()
  const session = state.status === 'signed-in' ? state.session : null
  return (
    <div className="min-h-screen bg-surface-2">
      <header className="border-b border-border bg-surface-1">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="font-semibold text-ink">Shri Health</span>
          <nav aria-label="Front desk" className="flex gap-1">
            <NavLink to="/schedule" className={navClass}>
              Schedule
            </NavLink>
            <NavLink to="/patients/search" className={navClass}>
              Patients
            </NavLink>
          </nav>
          {session ? (
            <div className="ml-auto flex items-center gap-3 text-sm text-ink-muted">
              <span>
                {session.user.displayName} · {session.organization.name}
              </span>
              <Button variant="ghost" size="sm" icon={<LogOut aria-hidden="true" size={14} />} onClick={() => void signOut()}>
                Sign out
              </Button>
            </div>
          ) : null}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <RegisterPrefillProvider>
          <Outlet />
        </RegisterPrefillProvider>
      </main>
    </div>
  )
}

export const routes: RouteObject[] = [
  {
    path: '/',
    element: (
      <SessionProvider>
        <Shell />
      </SessionProvider>
    ),
    children: [
      { index: true, element: <Navigate to="/patients/search" replace /> },
      { path: 'schedule', element: <SchedulePage /> },
      { path: 'patients/search', element: <PatientSearchPage /> },
      { path: 'patients/new', element: <RegisterPatientPage /> },
      { path: 'patients/:patientId', element: <PatientPage /> },
    ],
  },
  // The design-system preview needs no sign-in.
  { path: '/design-system', element: <DesignSystemPreview /> },
]

export function FrontDeskApp() {
  return <RouterProvider router={createBrowserRouter(routes)} />
}
