import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { IdleTimeoutWarning, Spinner } from '../../design-system'
import { PortalApiContext, type PortalApi } from './api/portalApi'
import type { PortalSession } from './api/types'
import './portal.css'
import { PortalShell } from './PortalShell'
import { matchPath, PortalRouter, useRouter } from './router'
import { SessionContext, type SessionApi } from './session'
import { DemographicsPage, ESignaturePage } from './pages/AccountPages'
import { AppointmentsPage, UpcomingAppointmentPage, VideoConsultPage, VisitSummaryPage } from './pages/appointments/AppointmentPages'
import { SchedulePage } from './pages/appointments/SchedulePage'
import { ActivatePage } from './pages/auth/ActivatePage'
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

const SIGNED_OUT_PATHS = ['/sign-in']

export function PortalApp({ api }: { api: PortalApi }) {
  return (
    <PortalApiContext.Provider value={api}>
      <PortalRouter>
        <Gate api={api} />
      </PortalRouter>
    </PortalApiContext.Provider>
  )
}

function Gate({ api }: { api: PortalApi }) {
  const { path, navigate } = useRouter()
  const [state, setState] = useState<{ kind: 'checking' } | { kind: 'signed-out'; reason?: SignedOutReason } | { kind: 'signed-in'; session: PortalSession }>({ kind: 'checking' })

  useEffect(() => {
    api.refreshSession().then(
      (session) => setState({ kind: 'signed-in', session }),
      () => setState({ kind: 'signed-out' }),
    )
  }, [api])

  const signOut = useCallback(
    (reason: 'signed-out' | 'expired' = 'signed-out') => {
      void api.signOut().catch(() => undefined)
      setState({ kind: 'signed-out', reason })
      navigate('/sign-in', { replace: true })
    },
    [api, navigate],
  )

  const refresh = useCallback(async () => {
    const session = await api.refreshSession()
    setState({ kind: 'signed-in', session })
  }, [api])

  const sessionApi = useMemo<SessionApi | null>(
    () => (state.kind === 'signed-in' ? { session: state.session, signOut, refresh } : null),
    [state, signOut, refresh],
  )

  if (state.kind === 'checking') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label="Opening your portal" />
      </div>
    )
  }

  if (state.kind === 'signed-out' || !sessionApi) {
    return (
      <SignInPage
        {...(state.kind === 'signed-out' && state.reason ? { reason: state.reason } : {})}
        onSignedIn={(session) => {
          setState({ kind: 'signed-in', session })
          // The sign-in page shows at the URL the patient asked for, so they land there afterwards.
          navigate(SIGNED_OUT_PATHS.includes(path) ? '/' : path, { replace: true })
        }}
      />
    )
  }

  // A realm account not yet linked to a chart sees only activation (D85).
  if (!sessionApi.session.activated) {
    return <ActivatePage onActivated={(session) => setState({ kind: 'signed-in', session })} onSignOut={() => signOut('signed-out')} />
  }

  if (SIGNED_OUT_PATHS.includes(path)) {
    // Signed in and on a sign-in URL (for example after Back): go home instead.
    queueMicrotask(() => navigate('/', { replace: true }))
    return null
  }

  let page: ReactNode = <NotFoundPage />
  for (const route of ROUTES) {
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
        idleExpiresAt={sessionApi.session.idleExpiresAt}
        expiresAt={sessionApi.session.expiresAt}
        // The dialog shows its own busy and error state; a failed refresh lets the patient retry.
        onStaySignedIn={sessionApi.refresh}
        onSignOut={() => signOut('signed-out')}
        onExpired={() => signOut('expired')}
      />
    </SessionContext.Provider>
  )
}
