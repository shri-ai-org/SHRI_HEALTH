/**
 * The screens this build draws, keyed by the registry's screen id
 * (`src/atlas/registry.ts`). Every routed screen in the registry gets its
 * address here; one without an entry shows the "being moved" frame until its
 * slice lands, so no address from the old build ever dead-ends.
 */

import type { ComponentType } from 'react'

import { ClinicianAssistantPage, StrokeAssistantPage } from '../assistant/AssistantPage'
import { DischargeBoardPage } from '../discharge/DischargeBoardPage'
import { DeathPage } from '../discharge/DeathPage'
import { DischargeSummaryPage } from '../discharge/DischargeSummaryPage'
import { MedRecPage } from '../discharge/MedRecPage'
import { StudyViewerPage } from '../imaging/StudyViewerPage'
import { WorklistPage } from '../imaging/WorklistPage'
import { AssessmentPage } from '../inpatients/AssessmentPage'
import { InpatientsPage } from '../inpatients/InpatientsPage'
import { ProgressNotePage } from '../inpatients/ProgressNotePage'
import { MyDayPage } from '../myday/MyDayPage'
import { CoSignPage } from '../notes/CoSignPage'
import { ConsultationPage } from '../notes/ConsultationPage'
import { InstructionsPage } from '../notes/InstructionsPage'
import { PrescriptionPage } from '../notes/PrescriptionPage'
import { ProblemsPage } from '../notes/ProblemsPage'
import { TemplatesPage } from '../notes/TemplatesPage'
import { NewOrdersPage } from '../orders/NewOrdersPage'
import { CohortsPage } from '../patients/CohortsPage'
import { OpdQueuePage } from '../patients/OpdQueuePage'
import { AdrReportPage } from '../pharmacy/AdrReportPage'
import { OrderSetsPage } from '../orders/OrderSetsPage'
import { OrdersPage } from '../orders/OrdersPage'
import { StewardshipPage } from '../orders/StewardshipPage'
import { AppointmentsPage } from '../record/AppointmentsPage'
import { ConditionPage } from '../record/ConditionPage'
import { NotesPage } from '../record/NotesPage'
import { PrescriptionsPage } from '../record/PrescriptionsPage'
import { RecordPage } from '../record/RecordPage'
import { ReportsPage } from '../record/ReportsPage'
import { ResultsPartPage } from '../record/ResultsPartPage'
import { TimelinePage } from '../record/TimelinePage'
import { ResultDetailPage } from '../results/ResultDetailPage'
import { ResultsInboxPage } from '../results/ResultsInboxPage'
import { BlocksPage } from '../schedule/BlocksPage'
import { ReferralsPage } from '../schedule/ReferralsPage'
import { SessionTemplatesPage } from '../schedule/SessionTemplatesPage'
import { ActivatePage } from '../stroke/ActivatePage'
import { AiConsolePage } from '../stroke/AiConsolePage'
import { CaseClockPage } from '../stroke/CaseClockPage'
import { IntakePage } from '../stroke/IntakePage'
import { SitesPage } from '../stroke/SitesPage'
import { TaskBoardPage } from '../stroke/TaskBoardPage'
import { TeamPage } from '../stroke/TeamPage'
import { TelestrokeQueuePage } from '../stroke/TelestrokeQueuePage'
import { TimestampsPage } from '../stroke/TimestampsPage'
import { WallPage } from '../stroke/WallPage'
import { AspectsPage } from '../stroke/AspectsPage'
import { EvtPage } from '../stroke/EvtPage'
import { ImagingTriagePage } from '../stroke/ImagingTriagePage'
import { NihssPage } from '../stroke/NihssPage'
import { PerfusionPage } from '../stroke/PerfusionPage'
import { RegistryPage } from '../stroke/RegistryPage'
import { SpokeConsolePage } from '../stroke/SpokeConsolePage'
import { TelestrokePage } from '../stroke/TelestrokePage'
import { ThrombolysisPage } from '../stroke/ThrombolysisPage'
import { TransferPage } from '../stroke/TransferPage'
import { TeleQueuePage } from '../telehealth/TeleQueuePage'
import { TeleRxPage } from '../telehealth/TeleRxPage'
import { TeleSessionPage } from '../telehealth/TeleSessionPage'


export const SCREEN_COMPONENTS: Partial<Record<string, ComponentType>> = {
  'S-06-01': MyDayPage,
  'S-06-03': ConsultationPage,
  'S-06-05': ProblemsPage,
  'S-06-06': TimelinePage,
  'S-06-07': PrescriptionPage,
  'S-06-08': InstructionsPage,
  'S-06-09': CoSignPage,
  'S-06-10': TemplatesPage,
  'S-06-11': RecordPage,
  'S-06-12': ReportsPage,
  'S-06-13': ResultsPartPage,
  'S-06-14': NotesPage,
  'S-06-15': ConditionPage,
  'S-06-16': PrescriptionsPage,
  'S-06-17': AppointmentsPage,
  'S-05-03': OpdQueuePage,
  'S-05-10': CohortsPage,
  'S-05-04': SessionTemplatesPage,
  'S-05-05': BlocksPage,
  'S-05-06': ReferralsPage,
  'S-16-08': AdrReportPage,
  'S-08-03': InpatientsPage,
  'S-08-04': ProgressNotePage,
  'S-08-07': AssessmentPage,
  'S-09-01': NewOrdersPage,
  'S-09-02': OrderSetsPage,
  'S-09-03': OrdersPage,
  'S-09-04': ResultsInboxPage,
  'S-09-05': ResultDetailPage,
  'S-09-08': StewardshipPage,
  'S-13-01': DischargeBoardPage,
  'S-13-02': DischargeSummaryPage,
  'S-13-03': MedRecPage,
  'S-13-06': DeathPage,
  'S-15-01': WorklistPage,
  'S-15-04': StudyViewerPage,
  'S-18-01': WallPage,
  'S-18-03': SitesPage,
  'S-18-04': ActivatePage,
  'S-18-05': IntakePage,
  'S-18-06': CaseClockPage,
  'S-18-07': TaskBoardPage,
  'S-18-08': TimestampsPage,
  'S-18-09': TeamPage,
  'S-18-10': TelestrokeQueuePage,
  'S-18-11': TelestrokePage,
  'S-18-12': NihssPage,
  'S-18-13': SpokeConsolePage,
  'S-18-14': ImagingTriagePage,
  'S-18-15': AspectsPage,
  'S-18-16': PerfusionPage,
  'S-18-17': ThrombolysisPage,
  'S-18-18': EvtPage,
  'S-18-19': TransferPage,
  'S-18-20': RegistryPage,
  'S-18-21': AiConsolePage,
  'S-27-02': TeleQueuePage,
  'S-27-03': TeleSessionPage,
  'S-27-04': TeleRxPage,
  'S-28-02': ClinicianAssistantPage,
  'S-28-09': StrokeAssistantPage,
}

/**
 * Screens that draw the old frame's content states themselves — LOADING, EMPTY
 * and ERROR in place of their content, under their own heading and patient
 * banner, as the old frame did (`src/shell/Screen.tsx:182-290`). Any other
 * drawn screen gets ERROR from the route wrapper, whole.
 */
export const OWN_STATES = new Set(['S-06-01', 'S-06-03', 'S-06-05', 'S-06-06', 'S-06-07', 'S-06-08', 'S-06-09', 'S-06-10', 'S-06-11', 'S-06-12', 'S-06-13', 'S-06-14', 'S-06-15', 'S-06-16', 'S-06-17', 'S-08-03', 'S-08-04', 'S-08-07', 'S-09-01', 'S-09-02', 'S-09-03', 'S-09-04', 'S-09-05', 'S-09-08', 'S-13-01', 'S-13-02', 'S-13-03', 'S-13-06', 'S-15-01', 'S-15-04', 'S-18-11', 'S-18-12', 'S-18-13', 'S-18-14', 'S-18-15', 'S-18-16', 'S-18-17', 'S-18-18', 'S-18-19', 'S-18-20', 'S-18-21'])
