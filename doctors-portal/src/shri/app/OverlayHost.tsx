/**
 * The scrim-backed overlays the shell owns (§6). Each one reads its own open
 * flag from the store and renders nothing otherwise, so this host stays a
 * flat list. The explain drawer brings its own scrim, so it can sit over the
 * Quick-Panel it is opened from.
 */

import { ExplainDrawer } from '../overlays/ExplainDrawer'
import { QuickPanel } from '../overlays/QuickPanel'
import { NoteModal } from '../overlays/NoteModal'
import { PatientSearch } from '../overlays/PatientSearch'
import { DischargeFlow } from '../discharge/DischargeFlow'
import { AdmitModal } from '../record/AdmitModal'
import { ScheduleDialogs } from '../schedule/ScheduleDialogs'

export function OverlayHost() {
  return (
    <>
      <QuickPanel />
      <ExplainDrawer />
      <NoteModal />
      <AdmitModal />
      <DischargeFlow />
      <PatientSearch />
      <ScheduleDialogs />
    </>
  )
}
