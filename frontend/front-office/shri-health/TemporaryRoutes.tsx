// The patient's insurance (demo step 3; M9, RUN_CHECK 28). Neither care-entry nor the doctors'
// portal has an insurance screen (frontend/docs/SCREEN_PORT.md), so the coverage panel Claude built
// earlier (src/features/patients/insurance) is shown at /patients/:uhid/insurance, opened from the
// patient profile's Insurance button, under the front office's own page header, until Minalini
// decides after the demo. The old /temporary/insurance/:patientId address redirects here.
import { ChevronLeft } from 'lucide-react'
import { Link, Navigate, useParams } from 'react-router-dom'

import { InsurancePanel } from '../../src/features/patients/insurance/InsurancePanel'
import { ToastProvider } from '../../src/design-system'
import { PageHeader } from '../src/components/layout/PageHeader'
import { useStoreValue } from '../src/hooks/useStore'
import { getPatientById } from '../src/domain/selectors'

/** `/patients/:uhid/insurance`: the patient's coverages, with the way back to their profile. */
export function PatientInsurancePage() {
  const { uhid = '' } = useParams()
  const patient = useStoreValue(getPatientById, uhid)
  return (
    <div>
      <Link
        to={`/patients/${uhid}`}
        className="focus-ring mb-2 inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-semibold text-primary-text hover:underline"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Patient profile
      </Link>
      {/* The patient, then the panel's own "Insurance" section with Add insurance. */}
      <PageHeader title={patient ? patient.name : 'Patient insurance'} subtitle={patient ? `MRN ${patient.uhid}` : undefined} />
      <ToastProvider>
        <InsurancePanel patientId={uhid} />
      </ToastProvider>
    </div>
  )
}

/** The demo's earlier address, kept working. */
export function TemporaryInsuranceRedirect() {
  const { patientId = '' } = useParams()
  return <Navigate to={`/patients/${patientId}/insurance`} replace />
}
