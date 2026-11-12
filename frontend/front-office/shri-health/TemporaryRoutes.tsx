// TEMPORARY — no source screen (frontend/docs/SCREEN_PORT.md). Neither care-entry nor the
// doctors' portal has an insurance screen, so demo step 3 uses the screen Claude built earlier
// until Minalini decides after the demo. Rooming (step 6) is now care-entry's rooming sheet
// (src/flows/rooming/RoomingFlow.tsx). Delete this file, its route in src/App.tsx and the
// @source lines in src/index.css together.
import { useParams } from 'react-router'

import { InsurancePanel } from '../../src/features/patients/insurance/InsurancePanel'
import { ToastProvider } from '../../src/design-system'

function TemporaryLabel({ step }: { step: string }) {
  return (
    <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">
      TEMPORARY — no source screen · demo step {step}
    </p>
  )
}

/** Demo step 3: the patient's coverages (`/temporary/insurance/:patientId`). */
export function TemporaryInsurance() {
  const { patientId = '' } = useParams()
  return (
    <ToastProvider>
      <TemporaryLabel step="3, insurance" />
      <InsurancePanel patientId={patientId} />
    </ToastProvider>
  )
}
