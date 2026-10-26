import { createContext, useContext } from 'react'
import type {
  Allergy,
  Appointment,
  AppointmentAlert,
  AppointmentCategory,
  AppointmentRequest,
  Bill,
  Demographics,
  DocumentTemplate,
  Facility,
  HealthIssue,
  Immunization,
  LabResult,
  Message,
  MessageCreate,
  Page,
  PatientReport,
  Payment,
  PaymentCreate,
  PortalDocument,
  PortalSession,
  Prescription,
  Provider,
  ReferenceLists,
  RefillRequest,
  RefillRequestCreate,
  Signature,
  Slot,
  VisitSummary,
  Vital,
} from './types'

/**
 * Everything the portal screens call, following the old portal's screens. Errors are thrown as
 * Problem Details (`code` decides the copy). The mock in mockPortalApi.ts implements this today;
 * the generated `/portal` client will.
 */
export interface PortalApi {
  // Session. The session is an HttpOnly cookie set by the server; the browser never holds a token.
  /**
   * Signs in at the patient Keycloak realm, with multi-factor (D85). The real client navigates to
   * the realm, so its promise never settles; the mock signs in its synthetic patient. Passwords,
   * multi-factor, reset and recovery all stay in the realm: this code never sees a password (D3).
   */
  signIn(): Promise<PortalSession>
  signOut(): Promise<void>
  refreshSession(): Promise<PortalSession>
  /**
   * Links the signed-in realm account to the patient's chart, once, with the invitation code the
   * front desk issued after an ID check (`POST /portal/enrolments`, D85).
   */
  activateAccount(invitationCode: string): Promise<PortalSession>
  /** The patient realm's own account page: password, multi-factor and recovery settings. */
  readonly accountSecurityUrl: string
  getReferenceLists(): Promise<ReferenceLists>

  getAlerts(): Promise<AppointmentAlert[]>

  getDemographics(): Promise<Demographics>
  updateDemographics(input: Demographics): Promise<Demographics>
  getSignature(): Promise<Signature | null>
  saveSignature(image: string): Promise<Signature>

  listAppointments(): Promise<Appointment[]>
  getAppointment(appointmentId: string): Promise<Appointment>
  cancelAppointment(appointmentId: string): Promise<Appointment>
  listFacilities(): Promise<Facility[]>
  listCategories(): Promise<AppointmentCategory[]>
  listProviders(facilityId: string): Promise<Provider[]>
  findSlots(input: { date: string; facilityId: string; providerId: string; durationMinutes: number }): Promise<Slot[]>
  bookAppointment(input: AppointmentRequest): Promise<Appointment>
  rescheduleAppointment(appointmentId: string, input: AppointmentRequest): Promise<Appointment>
  getVisitSummary(visitSummaryId: string): Promise<VisitSummary>
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
  listHealthIssues(): Promise<HealthIssue[]>
  getHealthIssue(issueId: string): Promise<HealthIssue>
  listAllergies(): Promise<Allergy[]>
  getAllergy(allergyId: string): Promise<Allergy>
  listImmunizations(): Promise<Immunization[]>
  getImmunization(immunizationId: string): Promise<Immunization>
  listVitals(): Promise<Vital[]>

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

export const PortalApiContext = createContext<PortalApi | null>(null)

export function usePortalApi(): PortalApi {
  const api = useContext(PortalApiContext)
  if (!api) throw new Error('usePortalApi must be used inside <PortalApiContext.Provider>')
  return api
}
