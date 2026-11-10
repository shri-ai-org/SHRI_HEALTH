import type { ReactNode } from 'react'
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom'
import { AppLayout } from './layouts/AppLayout'
import { ThemeProvider } from './contexts/ThemeProvider'
import { ToastProvider } from './components/ui/ToastProvider'
import { FrontOfficeHomePage } from './pages/FrontOfficeHomePage'
import { PatientsPage } from './pages/PatientsPage'
import { RegisterPatientPage } from './pages/RegisterPatientPage'
import { PatientProfilePage } from './pages/PatientProfilePage'
import { DoctorDirectoryPage } from './pages/DoctorDirectoryPage'
import { RegisterDoctorPage } from './pages/RegisterDoctorPage'
import { DoctorProfilePage } from './pages/DoctorProfilePage'
import { OutpatientsPage } from './pages/OutpatientsPage'
import { GuestPassPage } from './pages/GuestPassPage'
import { ActivityAnalyticsPage } from './pages/ActivityAnalyticsPage'
import { GuestPassPrintPage } from './pages/GuestPassPrintPage'
import { EnquiryEstimatePage } from './pages/EnquiryEstimatePage'
import { MlcPage } from './pages/MlcPage'
import { BillingPage } from './pages/BillingPage'
import { InpatientsPage } from './pages/InpatientsPage'
import { PaymentDetailPage } from './pages/PaymentDetailPage'
import { PaymentReceiptPage } from './pages/PaymentReceiptPage'
import { BillPrintHost } from './components/payment/BillPrintHost'
import { NotFoundPage } from './pages/NotFoundPage'
import { todayKey } from './domain/time'
import { useStoreValue } from './hooks/useStore'
import { getAdmissionById } from './domain/admissionSelectors'

/**
 * Starts the page afresh when its query changes — Register opened from the
 * search box carries what was typed (?name= / ?mobile=). Keyed on the query
 * only, never on every navigation, so a flow opening over a page never
 * resets it.
 */
function FreshOnQuery({ children }: { children: ReactNode }) {
  const { search } = useLocation()
  return <div key={search}>{children}</div>
}

/** An old address that now lives elsewhere: goes there, keeping whatever
 *  the old link carried in its query (an open flow, a filter). */
function KeepQueryRedirect({ to }: { to: string }) {
  const { search } = useLocation()
  const [path, fixed = ''] = to.split('?')
  const query = new URLSearchParams(fixed)
  for (const [key, value] of new URLSearchParams(search)) if (!query.has(key)) query.set(key, value)
  const rest = query.toString()
  return <Navigate to={rest ? `${path}?${rest}` : path} replace />
}

/** Old links to /appointments/new (with a doctor or slot in router state)
 *  open the schedule flow over Patients › Outpatients, carrying that starting point. */
function ScheduleRedirect() {
  const location = useLocation()
  const state = (location.state ?? {}) as { providerId?: string; slot?: string; date?: string }
  const params = new URLSearchParams({ flow: 'schedule' })
  if (state.providerId) params.set('doctor', state.providerId)
  if (state.slot) {
    params.set('date', state.date ?? todayKey())
    params.set('slot', state.slot)
  }
  return <Navigate to={`/patients/outpatients?${params.toString()}`} replace />
}

/** Old links to /admissions/discharge (with an admission in router state)
 *  open the discharge flow over Patients › Inpatients. */
function DischargeRedirect() {
  const location = useLocation()
  const admissionId = (location.state as { admissionId?: string } | null)?.admissionId
  const params = new URLSearchParams({ flow: 'discharge' })
  if (admissionId) params.set('admission', admissionId)
  return <Navigate to={`/patients/inpatients?${params.toString()}`} replace />
}

/** An admission has no page of its own any more — it lives on the patient's
 *  profile. */
function AdmissionRedirect() {
  const { admissionId } = useParams<{ admissionId: string }>()
  const admission = useStoreValue(getAdmissionById, admissionId ?? '')
  return <Navigate to={admission ? `/patients/${admission.patientId}` : '/patients/inpatients'} replace />
}

// No auth route — no authentication or backend infrastructure is built here
// (none exists to integrate with). The app opens straight into the shared
// Care Entry workspace.
function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        {/* "Print bill" prints from any page or flow, without leaving it. */}
        <BillPrintHost />
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<FrontOfficeHomePage />} />

            {/* Patients — one list; finding a patient is the search in the app bar */}
            {/* Patients — one place, three views: everyone, outpatients, inpatients */}
            <Route path="/patients" element={<PatientsPage />} />
            <Route path="/patients/outpatients" element={<OutpatientsPage />} />
            <Route path="/patients/inpatients" element={<InpatientsPage />} />
            <Route path="/patients/search" element={<Navigate to="/patients" replace />} />
            <Route path="/patients/:uhid" element={<PatientProfilePage />} />
            <Route
              path="/register/new"
              element={
                <FreshOnQuery>
                  <RegisterPatientPage />
                </FreshOnQuery>
              }
            />

            {/* Doctors */}
            <Route path="/doctors" element={<DoctorDirectoryPage />} />
            <Route path="/doctors/register" element={<RegisterDoctorPage />} />
            {/* Legacy path — doctor availability lives in the schedule flow. */}
            <Route path="/doctors/availability" element={<KeepQueryRedirect to="/patients/outpatients?flow=schedule" />} />
            <Route path="/doctors/:providerId" element={<DoctorProfilePage />} />

            {/* Old Outpatients, Appointments and Queue addresses lead to
                Patients › Outpatients; scheduling is a flow over the page. */}
            <Route path="/outpatients" element={<KeepQueryRedirect to="/patients/outpatients" />} />
            <Route path="/appointments/new" element={<ScheduleRedirect />} />
            <Route path="/appointments" element={<KeepQueryRedirect to="/patients/outpatients" />} />
            <Route path="/op-queue" element={<KeepQueryRedirect to="/patients/outpatients?filter=waiting" />} />

            {/* Services */}
            <Route path="/services/guest-pass" element={<GuestPassPage />} />
            <Route path="/services/guest-pass/print" element={<GuestPassPrintPage />} />
            <Route path="/services/enquiry" element={<EnquiryEstimatePage />} />
            <Route path="/services/mlc" element={<MlcPage />} />

            {/* Billing — one page; collecting happens in the billing flow */}
            <Route path="/billing" element={<BillingPage />} />
            <Route path="/activity-analytics" element={<ActivityAnalyticsPage />} />
            <Route path="/reports" element={<Navigate to="/activity-analytics" replace />} />
            <Route path="/billing/bills" element={<Navigate to="/billing?filter=all" replace />} />

            {/* Old Inpatients addresses lead to Patients › Inpatients; admit and
                discharge are flows over the page. */}
            <Route path="/admissions" element={<KeepQueryRedirect to="/patients/inpatients" />} />
            <Route path="/admissions/new" element={<Navigate to="/patients?flow=admit" replace />} />
            <Route path="/admissions/list" element={<Navigate to="/patients/inpatients" replace />} />
            <Route path="/admissions/beds" element={<Navigate to="/patients/inpatients?filter=beds" replace />} />
            <Route path="/admissions/discharge" element={<DischargeRedirect />} />
            <Route path="/admissions/:admissionId" element={<AdmissionRedirect />} />

            {/* Payments — the old list pages now land on Billing's filters, and
                Collect Payment opens the billing flow; one bill and its
                receipt keep their own pages. */}
            <Route path="/payments" element={<Navigate to="/billing" replace />} />
            <Route path="/payments/pending" element={<Navigate to="/billing?filter=due" replace />} />
            <Route path="/payments/history" element={<Navigate to="/billing?filter=all" replace />} />
            <Route path="/payments/collect" element={<Navigate to="/billing?filter=due" replace />} />
            <Route path="/payments/:paymentId" element={<PaymentDetailPage />} />
            <Route path="/payments/:paymentId/receipt" element={<PaymentReceiptPage />} />

            {/* Legacy paths kept working so older links don't dead-end */}
            <Route path="/front-office" element={<Navigate to="/" replace />} />
            <Route path="/services/attendant-pass" element={<Navigate to="/services/guest-pass" replace />} />
            <Route path="/front-office/attendant-pass" element={<Navigate to="/services/guest-pass" replace />} />
            <Route path="/front-office/enquiry" element={<Navigate to="/services/enquiry" replace />} />
            <Route path="/front-office/mlc" element={<Navigate to="/services/mlc" replace />} />

            {/* Anything else: say so, inside the shell, instead of silently
                landing on the dashboard. */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </ToastProvider>
    </ThemeProvider>
  )
}

export default App
