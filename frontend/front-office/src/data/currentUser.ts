// TEMPORARY MOCK DATA.
// Stands in for a real auth/session/capability service, which does not exist
// in this project yet (see plan §18/§22 — no auth infrastructure is built as
// part of this task). Replace with a real session source when one exists.

export type Capability = 'registration.write' | 'appointment.write'

export interface CurrentUser {
  staffId: string
  name: string
  role: string
  initials: string
  facilityId: string
  capabilities: Capability[]
}

// Capability set per UI_ATLAS M-04.2/M-05.2 — registration.write and
// appointment.write, no clinical read, and (deliberately) no patient.merge
// (MRD persona only) and no facility.admin (overbooking policy, P-02 only).
const FRONT_OFFICE: Capability[] = ['registration.write', 'appointment.write']

/** The front-office staff of this desk. Only one is signed in for now; the
 *  rest will sign in through a login page when one exists. */
export const FRONT_OFFICE_STAFF: CurrentUser[] = [
  { staffId: 'meera-iyer', name: 'Meera Iyer', role: 'Care Entry Executive', initials: 'MI', facilityId: 'shri-main', capabilities: FRONT_OFFICE },
  { staffId: 'pradeep-nambiar', name: 'Pradeep Nambiar', role: 'Front Office Executive', initials: 'PN', facilityId: 'shri-main', capabilities: FRONT_OFFICE },
  { staffId: 'farhana-rizwan', name: 'Farhana Rizwan', role: 'Billing Executive', initials: 'FR', facilityId: 'shri-main', capabilities: FRONT_OFFICE },
  { staffId: 'gokul-anand', name: 'Gokul Anand', role: 'Admissions Desk Executive', initials: 'GA', facilityId: 'shri-main', capabilities: FRONT_OFFICE },
  { staffId: 'sowmya-deepak', name: 'Sowmya Deepak', role: 'Front Office Supervisor', initials: 'SD', facilityId: 'shri-main', capabilities: FRONT_OFFICE },
]

/** Who is signed in at this desk. */
export const currentFrontOfficeUser: CurrentUser = FRONT_OFFICE_STAFF.find((s) => s.staffId === 'gokul-anand')!
