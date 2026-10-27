import { API_BASE } from '../../../api/client'
import {
  bookPortalAppointment,
  cancelPortalAppointment,
  enrollInPortal,
  getPortalAllergy,
  getPortalAppointment,
  getPortalProblem,
  getPortalProfile,
  getPortalSession,
  getPortalVisitSummary,
  getPortalVisitSummaryDownloadUrl,
  listPortalAllergies,
  listPortalAppointments,
  listPortalBookingAppointmentTypes,
  listPortalBookingFacilities,
  listPortalBookingProviders,
  listPortalBookingSlots,
  listPortalProblems,
  listPortalVisitSummaries,
  listPortalVitals,
  refreshPortalSession,
  requestPortalChange,
  reschedulePortalAppointment,
  signOutOfPortal,
} from '../../../api/generated/endpoints/portal/portal'
import { allPages } from '../../scheduling/reference'
import type { PortalApi, PortalContractApi, PortalLaterApi } from './portalApi'

const LIMIT = 100

/**
 * The patient realm's account page (password, second factors), outside our API (D85). Keycloak is
 * served under `/kc/` and the realm is `shri-patients` (ADR-0013 §1).
 */
const ACCOUNT_SECURITY_URL = '/kc/realms/shri-patients/account'

/**
 * The success body of a generated call. The fetch wrapper throws `ApiError` for every non-2xx, so a
 * resolved call is the documented success; anything else is a contract mismatch.
 */
async function ok<R extends { status: number; data: unknown }, S extends R['status']>(call: Promise<R>, status: S): Promise<Extract<R, { status: S }>['data']> {
  const res = await call
  if (res.status !== status) throw new Error(`Expected ${status}, got ${res.status}`)
  return (res as Extract<R, { status: S }>).data
}

/** Paging parameters for one page of a cursor list. */
const page = (cursor?: string) => ({ limit: LIMIT, ...(cursor ? { cursor } : {}) })

/**
 * The B8a contract operations through the generated client (D89, M20). Everything later (B8b, P1)
 * comes from `later`, the in-memory mock, until its batch lands.
 */
export function createHttpPortalApi(later: PortalLaterApi): PortalApi {
  const contract: PortalContractApi = {
    startSignIn: () => window.location.assign(`${API_BASE}/portal/auth/login`),
    getSession: () => ok(getPortalSession(), 200),
    refreshSession: () => ok(refreshPortalSession(), 200),
    signOut: async () => {
      await signOutOfPortal()
    },
    enroll: async (input, idempotencyKey) => {
      await ok(enrollInPortal(input, { 'Idempotency-Key': idempotencyKey }), 204)
    },
    accountSecurityUrl: ACCOUNT_SECURITY_URL,

    getProfile: () => ok(getPortalProfile(), 200),
    requestChange: (input, idempotencyKey) => ok(requestPortalChange(input, { 'Idempotency-Key': idempotencyKey }), 201),

    listAppointments: (when) => allPages((cursor) => ok(listPortalAppointments({ ...page(cursor), ...(when ? { when } : {}) }), 200)),
    getAppointment: (id) => ok(getPortalAppointment(id), 200),
    cancelAppointment: (id, reasonText) => ok(cancelPortalAppointment(id, { reasonText }), 200),
    listBookingFacilities: () => allPages((cursor) => ok(listPortalBookingFacilities(page(cursor)), 200)),
    listBookingAppointmentTypes: (facilityId) => allPages((cursor) => ok(listPortalBookingAppointmentTypes({ facilityId, ...page(cursor) }), 200)),
    listBookingProviders: (facilityId, appointmentTypeId) =>
      allPages((cursor) => ok(listPortalBookingProviders({ facilityId, appointmentTypeId, ...page(cursor) }), 200)),
    listSlots: ({ providerId, ...rest }) => allPages((cursor) => ok(listPortalBookingSlots({ ...rest, ...(providerId ? { providerId } : {}), ...page(cursor) }), 200)),
    bookAppointment: (input, idempotencyKey) => ok(bookPortalAppointment(input, { 'Idempotency-Key': idempotencyKey }), 201),
    rescheduleAppointment: (id, input, idempotencyKey) => ok(reschedulePortalAppointment(id, input, { 'Idempotency-Key': idempotencyKey }), 201),

    listVisitSummaries: () => allPages((cursor) => ok(listPortalVisitSummaries(page(cursor)), 200)),
    getVisitSummary: (id) => ok(getPortalVisitSummary(id), 200),
    getVisitSummaryDownloadUrl: (id) => ok(getPortalVisitSummaryDownloadUrl(id), 200),

    listProblems: () => allPages((cursor) => ok(listPortalProblems(page(cursor)), 200)),
    getProblem: (id) => ok(getPortalProblem(id), 200),
    listAllergies: () => allPages((cursor) => ok(listPortalAllergies(page(cursor)), 200)),
    getAllergy: (id) => ok(getPortalAllergy(id), 200),
    listVitals: () => allPages((cursor) => ok(listPortalVitals(page(cursor)), 200)),
  }
  return { ...later, ...contract }
}
