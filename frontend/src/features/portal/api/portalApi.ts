import { createContext, useContext } from 'react'
import type {
  DemoSignInRequest,
  EnrollmentRequest,
  EnrollmentResult,
  PortalAllergy,
  PortalAppointment,
  PortalAppointmentCreate,
  PortalBookingAppointmentType,
  PortalBookingFacility,
  PortalBookingProvider,
  PortalChangeRequest,
  PortalChangeRequestCreate,
  PortalDownloadUrl,
  PortalLabResult,
  PortalMedication,
  PortalProblem,
  PortalProfile,
  PortalRescheduleRequest,
  PortalSession,
  PortalSlot,
  PortalVisitSummary,
  PortalVital,
} from '../../../api/generated/model'
import type {
  Bill,
  DocumentTemplate,
  Immunization,
  LabResult,
  Message,
  MessageCreate,
  Page,
  PatientReport,
  Payment,
  PaymentCreate,
  PortalDocument,
  Prescription,
  Provider,
  ReferenceLists,
  RefillRequest,
  RefillRequestCreate,
  Signature,
} from './types'

/**
 * Batch B8a (D89): the portal operations in the contract, served by the generated `/portal`
 * client (httpPortalApi.ts). Types are the generated ones. Errors are thrown as `ApiError`;
 * `toProblem()` turns them into Problems, and screens switch on `code`.
 */
export interface PortalContractApi {
  // Session. The session is an HttpOnly cookie set by the server; the browser never holds a token.
  /**
   * Starts sign-in at the patient Keycloak realm, with multi-factor (D85): a full-page navigation
   * to `GET /portal/auth/login`. Passwords, multi-factor, reset and recovery stay in the realm (D3).
   */
  startSignIn(): void
  /** `GET /portal/auth/session`: the signed-in patient, or a `401`. Never counts as activity. */
  getSession(): Promise<PortalSession>
  /** "Stay signed in": `POST /portal/auth/refresh` extends the idle timer. */
  refreshSession(): Promise<PortalSession>
  signOut(): Promise<void>
  /**
   * Redeems the emailed invitation (D124): the token from the link's `#t=` fragment and the
   * patient's date of birth (`POST /portal/enrollments`). Signed out. The answer is Keycloak's
   * one-time set-password link; every refusal is the same `422`, so nothing can be probed.
   */
  enroll(input: EnrollmentRequest, idempotencyKey: string): Promise<EnrollmentResult>
  /** Leaves for Keycloak's set-password page (`EnrollmentResult.redirectUrl`), at once; never stored. */
  openSetPassword(redirectUrl: string): void
  /**
   * Demo servers only (D121): `POST /portal/auth/demo-sign-in` with the mobile number and date of
   * birth. The server sets the session cookie and returns the session; every refusal is one `422`.
   */
  demoSignIn(input: DemoSignInRequest): Promise<PortalSession>
  /** The patient realm's own account page: password, multi-factor and recovery settings. */
  readonly accountSecurityUrl: string

  /** `GET /portal/me`, with pending change requests. */
  getProfile(): Promise<PortalProfile>
  /** Demographics edits are requests the front desk accepts or declines (D91). */
  requestChange(input: PortalChangeRequestCreate, idempotencyKey: string): Promise<PortalChangeRequest>

  /** Every page of the patient's appointments; `upcoming` also feeds the home page alerts (M20). */
  listAppointments(when?: 'upcoming' | 'past'): Promise<PortalAppointment[]>
  getAppointment(appointmentId: string): Promise<PortalAppointment>
  cancelAppointment(appointmentId: string, reasonText: string): Promise<PortalAppointment>
  listBookingFacilities(): Promise<PortalBookingFacility[]>
  listBookingAppointmentTypes(facilityId: string): Promise<PortalBookingAppointmentType[]>
  listBookingProviders(facilityId: string, appointmentTypeId: string): Promise<PortalBookingProvider[]>
  listSlots(input: { facilityId: string; appointmentTypeId: string; date: string; providerId?: string }): Promise<PortalSlot[]>
  bookAppointment(input: PortalAppointmentCreate, idempotencyKey: string): Promise<PortalAppointment>
  rescheduleAppointment(appointmentId: string, input: PortalRescheduleRequest, idempotencyKey: string): Promise<PortalAppointment>

  listVisitSummaries(): Promise<PortalVisitSummary[]>
  getVisitSummary(visitSummaryId: string): Promise<PortalVisitSummary>
  /** A short-lived link to the summary document; never kept (D86: held summaries have none). */
  getVisitSummaryDownloadUrl(visitSummaryId: string): Promise<PortalDownloadUrl>

  listProblems(): Promise<PortalProblem[]>
  getProblem(problemId: string): Promise<PortalProblem>
  listAllergies(): Promise<PortalAllergy[]>
  getAllergy(allergyId: string): Promise<PortalAllergy>
  listVitals(): Promise<PortalVital[]>

  /** The patient's own medications, active first; never drafts or entered-in-error (#389). */
  listMedications(): Promise<PortalMedication[]>
  /** The patient's own lab reports, newest first; a held one has its ID only (D90, #398). */
  listLabResults(): Promise<PortalLabResult[]>
}

/**
 * Everything not in the contract yet (B8b and P1, D88): messages, results, prescriptions,
 * documents, forms, bills, exports and video. The in-memory mock (mockPortalApi.ts) serves these
 * until their batches land; the screens that use them say so in their notes.
 */
export interface PortalLaterApi {
  getReferenceLists(): Promise<ReferenceLists>
  getSignature(): Promise<Signature | null>
  saveSignature(image: string): Promise<Signature>
  /** P1 (hidden behind `PORTAL_FEATURES.video`): the room link for a video appointment. */
  joinVideoVisit(appointmentId: string): Promise<{ joinUrl: string }>

  listMessages(folder: 'inbox' | 'sent' | 'trash'): Promise<Page<Message>>
  markMessageRead(messageId: string): Promise<void>
  sendMessage(input: MessageCreate): Promise<Message>
  moveMessagesToTrash(messageIds: string[]): Promise<void>
  /** Removes messages from the patient's trash. The practice keeps its copy (record retention). */
  deleteMessagesFromTrash(messageIds: string[]): Promise<void>
  listRecipients(): Promise<Provider[]>

  listResults(): Promise<LabResult[]>
  getResult(resultId: string): Promise<LabResult>
  listImmunizations(): Promise<Immunization[]>
  getImmunization(immunizationId: string): Promise<Immunization>

  listPrescriptions(): Promise<Prescription[]>
  requestRefill(input: RefillRequestCreate): Promise<RefillRequest>
  getRefillRequest(refillRequestId: string): Promise<RefillRequest>

  listBills(): Promise<Bill[]>
  makePayment(input: PaymentCreate): Promise<Payment>

  listDocuments(source: 'patient' | 'provider'): Promise<PortalDocument[]>
  uploadDocument(file: File): Promise<PortalDocument>
  downloadDocument(documentId: string): Promise<Blob>

  listTemplates(): Promise<DocumentTemplate[]>
  getTemplate(templateId: string): Promise<DocumentTemplate>
  saveTemplate(templateId: string, input: { values: Record<string, string>; signature?: string }): Promise<DocumentTemplate>
  sendTemplateForReview(templateId: string): Promise<DocumentTemplate>
  deleteTemplateDraft(templateId: string): Promise<DocumentTemplate>

  getPatientReport(): Promise<PatientReport>
  downloadReport(kind: 'ccr' | 'ccd' | 'pdf'): Promise<Blob>
}

export type PortalApi = PortalContractApi & PortalLaterApi

export const PortalApiContext = createContext<PortalApi | null>(null)

export function usePortalApi(): PortalApi {
  const api = useContext(PortalApiContext)
  if (!api) throw new Error('usePortalApi must be used inside <PortalApiContext.Provider>')
  return api
}
