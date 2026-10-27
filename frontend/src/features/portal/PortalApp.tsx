import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { onUnauthenticated, setCsrfSessionPath, setCsrfToken } from '../../api/client'
import type { PortalSession } from '../../api/generated/model'
import { IdleTimeoutWarning, Spinner } from '../../design-system'
import { PortalApiContext, type PortalApi } from './api/portalApi'
import { pathEnabled } from './features'
import './portal.css'
import { PortalShell } from './PortalShell'
import { matchPath, PortalRouter, useRouter } from './router'
import { SessionContext, type SessionApi } from './session'
import { DemographicsPage, ESignaturePage } from './pages/AccountPages'
import { AppointmentsPage, UpcomingAppointmentPage, VideoConsultPage, VisitSummaryPage } from './pages/appointments/AppointmentPages'
import { SchedulePage } from './pages/appointments/SchedulePage'
import { SetUpAccountPage } from './pages/auth/SetUpAccountPage'
import { SignInPage, type SignedOutReason } from './pages/auth/SignInPage'
import { BillingPage } from './pages/BillingPage'
import { HomePage } from './pages/HomePage'
import { ComposePage, MessagesPage } from './pages/MessagePages'
import { NotFoundPage } from './pages/NotFoundPage'
import { PatientEducationPage, PrescriptionsPage, RefillConfirmationPage } from './pages/PrescriptionPages'
import { PatientDocumentsPage, ReportsPage } from './pages/records/DocumentsAndReportsPages'
import { DocumentTemplatePage, DocumentTemplatesPage } from './pages/records/DocumentTemplatePages'
import { HealthTrendsPage } from './pages/records/HealthTrendsPage'
import {
  AllergiesPage,
  AllergyDetailPage,
  HealthIssueDetailPage,
  HealthIssuesPage,
  ImmunizationDetailPage,
  ImmunizationsPage,
  TestResultDetailPage,
  TestResultsPage,
} from './pages/records/RecordPages'

type Route = { pattern: string; render: (p: Record<string, string>) => ReactNode }

/** The old portal's screens, at readable URLs that carry only opaque IDs (D13). */
const ROUTES: Route[] = [
  { pattern: '/', render: () => <HomePage /> },
  { pattern: '/test-results', render: () => <TestResultsPage /> },
  { pattern: '/test-results/:resultId', render: (p) => <TestResultDetailPage resultId={p.resultId ?? ''} /> },
  { pattern: '/health-issues', render: () => <HealthIssuesPage /> },
  { pattern: '/health-issues/:issueId', render: (p) => <HealthIssueDetailPage issueId={p.issueId ?? ''} /> },
  { pattern: '/health-trends', render: () => <HealthTrendsPage /> },
  { pattern: '/allergies', render: () => <AllergiesPage /> },
  { pattern: '/allergies/:allergyId', render: (p) => <AllergyDetailPage allergyId={p.allergyId ?? ''} /> },
  { pattern: '/immunizations', render: () => <ImmunizationsPage /> },
  { pattern: '/immunizations/:immunizationId', render: (p) => <ImmunizationDetailPage immunizationId={p.immunizationId ?? ''} /> },
  { pattern: '/patient-documents', render: () => <PatientDocumentsPage /> },
  { pattern: '/reports', render: () => <ReportsPage /> },
  { pattern: '/document-templates', render: () => <DocumentTemplatesPage /> },
  { pattern: '/document-templates/:templateId', render: (p) => <DocumentTemplatePage templateId={p.templateId ?? ''} /> },
  { pattern: '/appointments', render: () => <AppointmentsPage /> },
  { pattern: '/appointments/schedule', render: () => <SchedulePage /> },
  { pattern: '/appointments/:appointmentId', render: (p) => <UpcomingAppointmentPage appointmentId={p.appointmentId ?? ''} /> },
  { pattern: '/appointments/:appointmentId/reschedule', render: (p) => <SchedulePage rescheduleId={p.appointmentId ?? ''} /> },
  { pattern: '/visit-summaries/:visitSummaryId', render: (p) => <VisitSummaryPage visitSummaryId={p.visitSummaryId ?? ''} /> },
  { pattern: '/messages', render: () => <MessagesPage folder="inbox" /> },
  { pattern: '/messages/inbox', render: () => <MessagesPage folder="inbox" /> },
  { pattern: '/messages/sent', render: () => <MessagesPage folder="sent" /> },
  { pattern: '/messages/trash', render: () => <MessagesPage folder="trash" /> },
  { pattern: '/messages/compose', render: () => <ComposePage /> },
  { pattern: '/prescriptions', render: () => <PrescriptionsPage /> },
  { pattern: '/prescriptions/requests/:refillRequestId', render: (p) => <RefillConfirmationPage refillRequestId={p.refillRequestId ?? ''} /> },
  { pattern: '/billing', render: () => <BillingPage /> },
  { pattern: '/video-consult', render: () => <VideoConsultPage /> },
  { pattern: '/patient-education', render: () => <PatientEducationPage /> },
  { pattern: '/demographics', render: () => <DemographicsPage /> },
  { pattern: '/e-signature', render: () => <ESignaturePage /> },
]

const SIGNED_OUT_PATHS = ['/sign-in', '/set-up-account']

export function PortalApp({ api }: { api: PortalApi }) {
  return (
    <PortalApiContext.Provider value={api}>
      <PortalRouter>
        <Gate api={api} />
      </PortalRouter>
    </PortalApiContext.Provider>
  )
}

type GateState = { kind: 'checking' } | { kind: 'signed-out'; reason?: SignedOutReason } | { kind: 'signed-in'; session: PortalSession }

function Gate({ api }: { api: PortalApi }) {
  const { path, navigate } = useRouter()
  const [state, setState] = useState<GateState>({ kind: 'checking' })
  // The status for the 401 listener, set with the state (not in an effect), as in the staff session.
  const signedInRef = useRef(false)

  const signedIn = useCallback((session: PortalSession) => {
    setCsrfToken(session.csrfToken)
    signedInRef.current = true
    setState({ kind: 'signed-in', session })
  }, [])

  const ended = useCallback(
    (reason?: SignedOutReason) => {
      setCsrfToken(null)
      signedInRef.current = false
      setState(reason ? { kind: 'signed-out', reason } : { kind: 'signed-out' })
      if (reason) navigate('/sign-in', { replace: true })
    },
    [navigate],
  )

  useEffect(() => {
    // The portal's CSRF token comes from its own session (ADR-0013 §5).
    setCsrfSessionPath('/portal/auth/session')
    let live = true
    // Reading the session never counts as activity, so it doesn't extend the idle timer.
    api.getSession().then(
      (session) => live && signedIn(session),
      () => live && ended(),
    )
    return () => {
      live = false
    }
  }, [api, signedIn, ended])

  // Any call answered 401: the server has ended the session.
  useEffect(
    () =>
      onUnauthenticated(() => {
        if (signedInRef.current) ended('expired')
      }),
    [ended],
  )

  const signOut = useCallback(
    (reason: 'signed-out' | 'expired' = 'signed-out') => {
      void api.signOut().catch(() => undefined)
      ended(reason)
    },
    [api, ended],
  )

  const refresh = useCallback(async () => {
    signedIn(await api.refreshSession())
  }, [api, signedIn])

  // The local clock says a limit has passed: end the session only if the server agrees, as the
  // staff session does. A failed read fails closed.
  const expired = useCallback(async () => {
    try {
      const s = await api.getSession()
      const now = Date.now()
      if (Date.parse(s.idleExpiresAt) > now && Date.parse(s.expiresAt) > now) return signedIn(s)
    } catch {
      // Ended on the server, or unreachable: sign out here too.
    }
    signOut('expired')
  }, [api, signedIn, signOut])

  const session = state.kind === 'signed-in' ? state.session : null
  const sessionApi = useMemo<SessionApi | null>(() => (session ? { session, signOut, refresh } : null), [session, signOut, refresh])

  if (state.kind === 'checking') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label="Opening your portal" />
      </div>
    )
  }

  if (state.kind === 'signed-out') {
    // Enrolment comes before any sign-in: the realm account doesn't exist until the code is used.
    if (path === '/set-up-account') return <SetUpAccountPage />
    // Sign-in leaves for the realm and comes back through `/portal/auth/callback`, which sets the
    // cookie and returns to the portal.
    return <SignInPage {...(state.kind === 'signed-out' && state.reason ? { reason: state.reason } : {})} />
  }

  if (SIGNED_OUT_PATHS.includes(path)) {
    // Signed in and on a sign-in URL (for example after Back): go home instead.
    queueMicrotask(() => navigate('/', { replace: true }))
    return null
  }

  let page: ReactNode = <NotFoundPage />
  for (const route of ROUTES.filter((r) => pathEnabled(r.pattern))) {
    const params = matchPath(route.pattern, path)
    if (params) {
      page = route.render(params)
      break
    }
  }

  return (
    <SessionContext.Provider value={sessionApi}>
      <PortalShell>
        {/* key: each page starts fresh, so state from one record never shows on another. */}
        <div key={path}>{page}</div>
      </PortalShell>
      <IdleTimeoutWarning
        idleExpiresAt={state.session.idleExpiresAt}
        expiresAt={state.session.expiresAt}
        // The dialog shows its own busy and error state; a failed refresh lets the patient retry.
        onStaySignedIn={refresh}
        onSignOut={() => signOut('signed-out')}
        onExpired={() => void expired()}
      />
    </SessionContext.Provider>
  )
}
