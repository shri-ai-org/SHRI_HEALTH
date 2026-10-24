import { todayIn, type Money, type Problem } from '../../../design-system'
import type { PortalApi } from './portalApi'
import type {
  Allergy,
  Appointment,
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
  Pharmacy,
  PortalDocument,
  Prescription,
  Provider,
  ReferenceLists,
  RefillRequest,
  Signature,
  Slot,
  VisitSummary,
  Vital,
} from './types'

/*
 * In-memory stand-in for the `/portal` API until the contract and backend exist.
 * SYNTHETIC DATA ONLY: Synthea-style names, 555-01xx phones, made-up IDs (CLAUDE.md).
 * Each call to createMockPortalApi() starts from fresh data, so tests do not leak into each other.
 */

const TZ = 'America/Chicago'
const PATIENT_ID = uid(1)

/** Stable UUID-shaped IDs, so links keep working across reloads. */
export function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

function usd(value: string): Money {
  return { value, currency: 'USD' }
}

function cents(m: Money): number {
  return Math.round(Number(m.value) * 100)
}

/** A UTC instant for `hour:minute` facility time, `dayOffset` days from today. */
export function facilityInstant(dayOffset: number, hour: number, minute = 0, now = new Date()): string {
  const day = new Date(now.getTime() + dayOffset * 86_400_000)
  const [y, m, d] = todayIn(TZ, day).split('-').map(Number) as [number, number, number]
  const guess = Date.UTC(y, m - 1, d, hour, minute)
  const asZone = new Date(new Date(guess).toLocaleString('en-US', { timeZone: TZ }))
  const asUtc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' }))
  return new Date(guess - (asZone.getTime() - asUtc.getTime())).toISOString()
}

/** `dayOffset` moved forward to a weekday, so mock visits never fall on a closed day. */
function weekday(dayOffset: number): number {
  let d = dayOffset
  for (;;) {
    const wd = new Date(`${todayIn(TZ, new Date(Date.now() + d * 86_400_000))}T12:00:00Z`).getUTCDay()
    if (wd !== 0 && wd !== 6) return d
    d += 1
  }
}

function dateOffset(dayOffset: number): string {
  return todayIn(TZ, new Date(Date.now() + dayOffset * 86_400_000))
}

function addMinutes(instant: string, minutes: number): string {
  return new Date(new Date(instant).getTime() + minutes * 60_000).toISOString()
}

function problem(status: number, code: string, title: string): Problem {
  return { type: `https://company-domain.invalid/problems/${code}`, title, status, code, requestId: `req-${Math.random().toString(36).slice(2, 10)}` }
}

function ref<T extends { id: string; displayName: string }>(x: T) {
  return { id: x.id, displayName: x.displayName }
}

const FACILITIES: Facility[] = [
  {
    id: uid(101),
    displayName: 'Shri Health Springfield Clinic',
    timeZone: TZ,
    address: { lines: ['200 Example Ave', 'Suite 300'], city: 'Springfield', state: 'IL', postalCode: '62701' },
    phone: '+12175550142',
  },
  {
    id: uid(102),
    displayName: 'Shri Health Chatham Clinic',
    timeZone: TZ,
    address: { lines: ['15 Sample Rd'], city: 'Chatham', state: 'IL', postalCode: '62629' },
    phone: '+12175550188',
  },
]

const PROVIDERS: Provider[] = [
  { id: uid(201), displayName: 'Dr. Alvina Hettinger, MD', facilityIds: [uid(101)] },
  { id: uid(202), displayName: 'Dr. Marcus Okuneva, DO', facilityIds: [uid(101), uid(102)] },
  { id: uid(203), displayName: 'Jada Rempel, NP', facilityIds: [uid(102)] },
]

const CATEGORIES: AppointmentCategory[] = [
  { id: uid(301), displayName: 'Office Visit', mode: 'in-person' },
  { id: uid(302), displayName: 'Established Patient', mode: 'in-person' },
  { id: uid(303), displayName: 'New Patient', mode: 'in-person' },
  { id: uid(304), displayName: 'Video Visit', mode: 'video' },
]

const PHARMACIES: Pharmacy[] = [
  { id: uid(401), displayName: 'Sample Pharmacy #12', address: '900 Example Blvd, Springfield, IL 62704', phone: '+12175550160' },
  { id: uid(402), displayName: 'Placeholder Drug Co.', address: '31 Sample Rd, Chatham, IL 62629', phone: '+12175550163' },
  { id: uid(403), displayName: 'Example Rx Mail Order', address: 'Delivered to your home', phone: '+18005550199' },
]

const LISTS: ReferenceLists = {
  maritalStatuses: ['Married', 'Single', 'Divorced', 'Widowed', 'Separated', 'Domestic Partner'],
  races: ['American Indian or Alaska Native', 'Asian', 'Black or African American', 'Native Hawaiian or Other Pacific Islander', 'White', 'Other race', 'Declined to specify'],
  ethnicities: ['Hispanic or Latino', 'Not Hispanic or Latino', 'Declined to specify'],
  languages: ['English', 'Spanish', 'Chinese', 'Vietnamese', 'Tagalog', 'Arabic', 'French', 'Other'],
  relationships: ['Spouse', 'Parent', 'Child', 'Sibling', 'Grandparent', 'Guardian', 'Friend', 'Other'],
  countries: ['United States'],
  insuranceCompanies: ['Example Health Plan', 'Sample Mutual Insurance', 'Placeholder Care PPO', 'Medicare (sample)', 'Medicaid (sample)'],
  insuranceRelationships: ['Self', 'Spouse', 'Child', 'Other'],
  pharmacies: PHARMACIES,
  providers: PROVIDERS.map(ref),
}

function seed() {
  const [fac1, fac2] = FACILITIES as [Facility, Facility]
  const [drH, drO, npR] = PROVIDERS as [Provider, Provider, Provider]
  const [office, established, , video] = CATEGORIES as [AppointmentCategory, AppointmentCategory, AppointmentCategory, AppointmentCategory]

  const demographics: Demographics = {
    firstName: 'Ramona',
    middleName: 'Jean',
    lastName: 'Kuhlman',
    address: '48 Placeholder St',
    city: 'Springfield',
    state: 'IL',
    postalCode: '62704',
    country: 'United States',
    email: 'ramona.kuhlman@example.com',
    mobilePhone: '+12175550123',
    homePhone: '+12175550124',
    maritalStatus: 'Married',
    race: 'White',
    language: 'English',
    ethnicity: 'Not Hispanic or Latino',
    employer: { name: 'Example Manufacturing', address: '700 Sample Pkwy', city: 'Springfield', state: 'IL', postalCode: '62703', country: 'United States' },
    emergencyContact: { name: 'Lucas Kuhlman', relationship: 'Spouse', phone: '+12175550177' },
  }

  const vitals: Vital[] = [-400, -310, -220, -120, -34].map((d, i) => ({
    id: uid(700 + i),
    takenAt: facilityInstant(d, 10, 5),
    systolic: [128, 134, 141, 138, 131][i] ?? 130,
    diastolic: [82, 86, 90, 88, 84][i] ?? 84,
    pulse: [72, 76, 80, 74, 70][i] ?? 72,
    respiration: 16,
    weight: { value: [74.8, 75.6, 77.1, 76.2, 74.9][i] ?? 75, unit: 'kg' },
    height: { value: 165, unit: 'cm' },
    temperature: { value: 36.8, unit: 'Cel' },
    bmi: [27.5, 27.8, 28.3, 28.0, 27.5][i] ?? 27.5,
    bmiStatus: 'Overweight',
    waistCircumference: { value: 86, unit: 'cm' },
    oxygenSaturation: 98,
  }))

  const appointments: Appointment[] = [
    {
      id: uid(501), startAt: facilityInstant(weekday(2), 9, 30), endAt: facilityInstant(weekday(2), 9, 50), status: 'booked',
      category: ref(established), reason: 'Medical Problem Followup Visit', mode: 'in-person', provider: ref(drH), facility: fac1, reminder: 'text',
      canReschedule: true, canCancel: true, videoRoomOpen: false,
    },
    {
      id: uid(502), startAt: facilityInstant(weekday(9), 14, 0), endAt: facilityInstant(weekday(9), 14, 30), status: 'booked',
      category: ref(video), reason: 'Medical Problem Followup Visit', mode: 'video', provider: ref(drO), facility: fac1, reminder: 'email',
      canReschedule: true, canCancel: true, videoRoomOpen: false,
      instructions: 'Join from a quiet, private place with your medicines nearby.',
    },
    {
      id: uid(503), startAt: facilityInstant(-34, 10, 0), endAt: facilityInstant(-34, 10, 40), status: 'fulfilled',
      category: ref(office), reason: 'Annual Physical', mode: 'in-person', provider: ref(drH), facility: fac1, reminder: 'text',
      canReschedule: false, canCancel: false, videoRoomOpen: false, visitSummaryId: uid(601),
    },
    {
      id: uid(505), startAt: facilityInstant(-120, 11, 0), endAt: facilityInstant(-120, 11, 30), status: 'fulfilled',
      category: ref(video), reason: 'New Medical Problem Visit', mode: 'video', provider: ref(drO), facility: fac1, reminder: 'email',
      canReschedule: false, canCancel: false, videoRoomOpen: false, visitSummaryId: uid(602),
    },
    {
      id: uid(506), startAt: facilityInstant(-220, 15, 30), endAt: facilityInstant(-220, 15, 50), status: 'fulfilled',
      category: ref(established), reason: 'Medical Problem Followup Visit', mode: 'in-person', provider: ref(npR), facility: fac2, reminder: 'text',
      canReschedule: false, canCancel: false, videoRoomOpen: false, visitSummaryId: uid(603),
    },
  ]

  const visitSummaries: VisitSummary[] = [
    {
      id: uid(601), appointmentId: uid(503), date: dateOffset(-34), provider: ref(drH), reasons: ['Annual Physical'], vitals: vitals[4] ?? null,
      problemsAndAllergies: [{ title: 'Essential hypertension', diagnosis: 'ICD10:I10' }, { title: 'Penicillin', diagnosis: 'Allergy' }],
      prescriptions: ['Lisinopril 10 mg tablet'],
    },
    {
      id: uid(602), appointmentId: uid(505), date: dateOffset(-120), provider: ref(drO), reasons: ['New Medical Problem Visit', 'Headaches'], vitals: null,
      problemsAndAllergies: [{ title: 'Migraine without aura', diagnosis: 'ICD10:G43.009' }],
      prescriptions: ['Sumatriptan 50 mg tablet'],
    },
    {
      id: uid(603), appointmentId: uid(506), date: dateOffset(-220), provider: ref(npR), reasons: ['Medical Problem Followup Visit'], vitals: vitals[2] ?? null,
      problemsAndAllergies: [], prescriptions: [],
    },
  ]

  const lab = { name: 'Example Reference Laboratory', address: '1 Sample Way, Springfield, IL 62701', director: 'Dr. Placeholder Lab, MD', phone: '+12175550111' }
  const results: LabResult[] = [
    {
      id: uid(801), name: 'Basic metabolic panel', code: '80048', orderedAt: facilityInstant(-34, 10, 15), collectedAt: facilityInstant(-34, 10, 20), resultedAt: facilityInstant(-32, 8, 0),
      orderedBy: ref(drH), lab, status: 'final',
      components: [
        { name: 'Sodium', value: '139', unit: 'mmol/L', referenceRange: '136–145', flag: 'normal' },
        { name: 'Potassium', value: '5.3', unit: 'mmol/L', referenceRange: '3.5–5.1', flag: 'high' },
        { name: 'Chloride', value: '103', unit: 'mmol/L', referenceRange: '98–107', flag: 'normal' },
        { name: 'Glucose', value: '96', unit: 'mg/dL', referenceRange: '70–99', flag: 'normal' },
        { name: 'Creatinine', value: '0.9', unit: 'mg/dL', referenceRange: '0.6–1.1', flag: 'normal' },
      ],
    },
    {
      id: uid(802), name: 'Lipid panel', code: '80061', orderedAt: facilityInstant(-34, 10, 15), collectedAt: facilityInstant(-34, 10, 20), resultedAt: facilityInstant(-32, 8, 0),
      orderedBy: ref(drH), lab, status: 'final',
      components: [
        { name: 'Total cholesterol', value: '212', unit: 'mg/dL', referenceRange: '<200', flag: 'high' },
        { name: 'LDL cholesterol', value: '131', unit: 'mg/dL', referenceRange: '<100', flag: 'high' },
        { name: 'HDL cholesterol', value: '52', unit: 'mg/dL', referenceRange: '>=40', flag: 'normal' },
        { name: 'Triglycerides', value: '145', unit: 'mg/dL', referenceRange: '<150', flag: 'normal' },
      ],
    },
    {
      id: uid(803), name: 'Hemoglobin A1c', code: '83036', orderedAt: facilityInstant(-34, 10, 15), collectedAt: facilityInstant(-34, 10, 20), resultedAt: facilityInstant(-33, 8, 0),
      orderedBy: ref(drH), lab, status: 'final',
      components: [{ name: 'Hemoglobin A1c', value: '5.4', unit: '%', referenceRange: '<5.7', flag: 'normal' }],
    },
    {
      id: uid(805), name: 'Complete blood count', code: '85025', orderedAt: facilityInstant(-400, 10, 0), collectedAt: facilityInstant(-400, 10, 10), resultedAt: facilityInstant(-399, 8, 0),
      orderedBy: ref(drH), lab, status: 'final',
      components: [
        { name: 'White blood cells', value: '6.8', unit: '10³/µL', referenceRange: '4.0–11.0', flag: 'normal' },
        { name: 'Hemoglobin', value: '13.1', unit: 'g/dL', referenceRange: '12.0–15.5', flag: 'normal' },
        { name: 'Platelets', value: '251', unit: '10³/µL', referenceRange: '150–400', flag: 'normal' },
      ],
    },
  ]

  const healthIssues: HealthIssue[] = [
    { id: uid(901), title: 'Essential hypertension', diagnosis: 'ICD10:I10', beginDate: dateOffset(-700), occurrence: 'chronic', referredBy: drH.displayName, notes: 'Home blood pressure checks 3 times a week.' },
    { id: uid(902), title: 'Migraine without aura', diagnosis: 'ICD10:G43.009', beginDate: dateOffset(-140), occurrence: 'first', referredBy: drO.displayName },
    { id: uid(903), title: 'Elevated cholesterol', diagnosis: 'ICD10:E78.00', beginDate: dateOffset(-34), occurrence: 'first', referredBy: drH.displayName },
    { id: uid(904), title: 'Acute bronchitis', diagnosis: 'ICD10:J20.9', beginDate: dateOffset(-900), endDate: dateOffset(-880), occurrence: 'first', referredBy: npR.displayName },
  ]

  const allergies: Allergy[] = [
    { id: uid(1001), title: 'Penicillin', diagnosis: 'RXCUI:7980', reaction: 'Hives', beginDate: dateOffset(-1500), occurrence: 'unknown', referredBy: drH.displayName, notes: 'Avoid all penicillins.' },
    { id: uid(1002), title: 'Peanuts', reaction: 'Swelling of lips', beginDate: dateOffset(-1500), occurrence: 'chronic' },
    { id: uid(1003), title: 'Seasonal pollen', reaction: 'Sneezing, itchy eyes', beginDate: dateOffset(-700), endDate: dateOffset(-300), occurrence: 'late-recurrence' },
  ]

  const immunizations: Immunization[] = [
    { id: uid(1101), vaccine: 'Influenza, seasonal, injectable', administeredDate: dateOffset(-34), administeredBy: 'Jada Rempel, NP', amount: '0.5 mL', route: 'Intramuscular', site: 'Left deltoid', expirationDate: dateOffset(200), manufacturer: 'Example Biologics', completionStatus: 'completed' },
    { id: uid(1102), vaccine: 'COVID-19, updated', administeredDate: dateOffset(-60), administeredBy: 'Sample Pharmacy #12', amount: '0.3 mL', route: 'Intramuscular', site: 'Right deltoid', manufacturer: 'Example Biologics', completionStatus: 'completed' },
    { id: uid(1103), vaccine: 'Tdap', administeredDate: dateOffset(-1800), administeredBy: 'Dr. Alvina Hettinger, MD', amount: '0.5 mL', route: 'Intramuscular', site: 'Left deltoid', manufacturer: 'Example Biologics', completionStatus: 'completed' },
  ]

  const prescriptions: Prescription[] = [
    { id: uid(1201), drug: 'Lisinopril 10 mg tablet', provider: ref(drH), refillsRemaining: 2, lastRefilledDate: dateOffset(-25), requestStatus: 'none', note: 'Take 1 tablet by mouth once a day.', refillable: true },
    { id: uid(1202), drug: 'Sumatriptan 50 mg tablet', provider: ref(drO), refillsRemaining: 0, lastRefilledDate: dateOffset(-40), requestStatus: 'none', note: 'At the start of a migraine; may repeat once after 2 hours.', refillable: true },
    { id: uid(1203), drug: 'Cetirizine 10 mg tablet', provider: ref(npR), refillsRemaining: 5, lastRefilledDate: dateOffset(-70), requestStatus: 'approved', note: 'Once a day as needed.', refillable: true },
    { id: uid(1204), drug: 'Lorazepam 0.5 mg tablet', provider: ref(drO), refillsRemaining: 0, lastRefilledDate: dateOffset(-200), requestStatus: 'none', note: 'Controlled medicine: call the clinic for refills.', refillable: false },
  ]

  const me = { id: PATIENT_ID, displayName: 'Ramona Kuhlman' }
  const nurses = { id: uid(1301), displayName: 'Care team nurses' }
  const messages: Message[] = [
    { id: uid(1401), folder: 'inbox', subject: 'Non Urgent Medical Question', from: ref(drH), to: me, sentAt: facilityInstant(-31, 16, 12), read: false, body: 'Hi Ramona,\n\nYour lab results are in. Your potassium was slightly high; please avoid salt substitutes and we will recheck it at your follow-up.\n\nDr. Hettinger' },
    { id: uid(1402), folder: 'inbox', subject: 'Office Visit', from: nurses, to: me, sentAt: facilityInstant(-1, 9, 0), read: true, body: 'This is a reminder of your follow-up visit with Dr. Hettinger in 2 days.' },
    { id: uid(1404), folder: 'inbox', subject: 'Pharmacy/Prescription', from: ref(drO), to: me, sentAt: facilityInstant(-44, 11, 5), read: true, body: 'Yes, sumatriptan and lisinopril can be taken together.' },
    { id: uid(1403), folder: 'sent', subject: 'Pharmacy/Prescription', from: me, to: ref(drO), sentAt: facilityInstant(-45, 20, 41), read: true, body: 'Can I take sumatriptan together with my blood pressure medicine?' },
    { id: uid(1405), folder: 'trash', subject: 'Office Visit', from: nurses, to: me, sentAt: facilityInstant(-70, 8, 30), read: true, body: 'Walk-in flu shots are available weekdays 8 AM to 4 PM.' },
  ]

  const practice = { name: 'Shri Health Springfield Clinic', address: '200 Example Ave, Suite 300, Springfield, IL 62701' }
  const bills: Bill[] = [
    {
      id: uid(1501), practice, visitReason: 'Annual Physical', provider: ref(drH), serviceDate: dateOffset(-34),
      charges: usd('412.00'), insurancePaid: usd('298.40'), patientPaid: usd('0.00'), amountDue: usd('65.00'),
      lines: [
        { date: dateOffset(-34), description: 'Preventive visit, established patient (99396)', quantity: 1, unitPrice: usd('245.00'), total: usd('245.00') },
        { date: dateOffset(-34), description: 'Basic metabolic panel (80048)', quantity: 1, unitPrice: usd('48.00'), total: usd('48.00') },
        { date: dateOffset(-34), description: 'Lipid panel (80061)', quantity: 1, unitPrice: usd('62.00'), total: usd('62.00') },
        { date: dateOffset(-34), description: 'Hemoglobin A1c (83036)', quantity: 1, unitPrice: usd('42.00'), total: usd('42.00') },
        { date: dateOffset(-34), description: 'Flu vaccine (90686)', quantity: 1, unitPrice: usd('15.00'), total: usd('15.00') },
      ],
      adjustments: [
        { date: dateOffset(-20), description: 'Insurance payment', amount: usd('-298.40') },
        { date: dateOffset(-20), description: 'Insurance adjustment', amount: usd('-48.60') },
      ],
    },
    {
      id: uid(1502), practice, visitReason: 'New Medical Problem Visit', provider: ref(drO), serviceDate: dateOffset(-120),
      charges: usd('180.00'), insurancePaid: usd('132.00'), patientPaid: usd('0.00'), amountDue: usd('25.00'),
      lines: [{ date: dateOffset(-120), description: 'Video visit, established patient (99213)', quantity: 1, unitPrice: usd('180.00'), total: usd('180.00') }],
      adjustments: [
        { date: dateOffset(-100), description: 'Insurance payment', amount: usd('-132.00') },
        { date: dateOffset(-100), description: 'Insurance adjustment', amount: usd('-23.00') },
      ],
    },
    {
      id: uid(1503), practice: { name: 'Shri Health Chatham Clinic', address: '15 Sample Rd, Chatham, IL 62629' }, visitReason: 'Medical Problem Followup Visit', provider: ref(npR), serviceDate: dateOffset(-220),
      charges: usd('180.00'), insurancePaid: usd('132.00'), patientPaid: usd('25.00'), amountDue: usd('0.00'),
      lines: [{ date: dateOffset(-220), description: 'Office visit, established patient (99213)', quantity: 1, unitPrice: usd('180.00'), total: usd('180.00') }],
      adjustments: [
        { date: dateOffset(-200), description: 'Insurance payment', amount: usd('-132.00') },
        { date: dateOffset(-200), description: 'Insurance adjustment', amount: usd('-23.00') },
        { date: dateOffset(-190), description: 'Patient payment', amount: usd('-25.00') },
      ],
    },
  ]

  const documents: PortalDocument[] = [
    { id: uid(1701), name: 'Visit summary - annual physical.pdf', date: dateOffset(-34), source: 'provider', contentType: 'application/pdf', sizeBytes: 182_000 },
    { id: uid(1702), name: 'Work note.pdf', date: dateOffset(-120), source: 'provider', contentType: 'application/pdf', sizeBytes: 64_000 },
    { id: uid(1704), name: 'Insurance card front.jpg', date: dateOffset(-400), source: 'patient', contentType: 'image/jpeg', sizeBytes: 820_000 },
  ]

  const templates: DocumentTemplate[] = [
    {
      id: uid(1601), name: 'Patient Intake Form', createdAt: facilityInstant(-3, 9, 0), reviewStatus: 'not-sent', signed: false,
      intro: 'Please complete this form before your next visit. Your care team reviews it with you.',
      fields: [
        { id: 'concern', label: 'Main reason for your visit', kind: 'textarea' },
        { id: 'since', label: 'When did it start?', kind: 'date' },
        { id: 'bpHome', label: 'Do you check your blood pressure at home?', kind: 'yes-no' },
        { id: 'pharmacy', label: 'Preferred pharmacy', kind: 'text' },
      ],
      values: {},
      closing: 'I confirm that the information above is true to the best of my knowledge.',
    },
    {
      id: uid(1602), name: 'Telehealth Consent', createdAt: facilityInstant(-3, 9, 0), reviewStatus: 'not-sent', signed: false,
      intro: 'I agree to receive care by secure video. The visit is private and not recorded. My provider may ask me to come in person. In an emergency I will call 911.',
      fields: [{ id: 'phone', label: 'Phone number to call if the video drops', kind: 'text' }],
      values: {},
      closing: 'Signature of patient or legal guardian.',
    },
    {
      id: uid(1603), name: 'HIPAA Acknowledgement', createdAt: facilityInstant(-400, 9, 0), reviewedAt: facilityInstant(-399, 11, 0), reviewStatus: 'accepted', signed: true,
      intro: 'I acknowledge that I received the Notice of Privacy Practices.',
      fields: [], values: {},
    },
  ]

  return { demographics, appointments, visitSummaries, vitals, results, healthIssues, allergies, immunizations, prescriptions, messages, bills, documents, templates, me }
}

export interface MockOptions {
  /** Milliseconds per call; 0 in tests. */
  latencyMs?: number
}

export function createMockPortalApi({ latencyMs = 350 }: MockOptions = {}): PortalApi {
  const db = seed()
  let signedIn = false
  let signature: Signature | null = null
  const refillRequests: RefillRequest[] = []
  let nextId = 5000
  const newId = () => uid(nextId++)

  function wait<T>(value: () => T): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        try {
          resolve(value())
        } catch (e) {
          reject(e)
        }
      }
      if (latencyMs === 0) queueMicrotask(run)
      else setTimeout(run, latencyMs * (0.6 + Math.random() * 0.8))
    })
  }

  function authed<T>(fn: () => T): Promise<T> {
    return wait(() => {
      if (!signedIn) throw problem(401, 'unauthenticated', 'Unauthenticated')
      return structuredClone(fn())
    })
  }

  function find<T extends { id: string }>(list: T[], id: string): T {
    const item = list.find((x) => x.id === id)
    if (!item) throw problem(404, 'not-found', 'Not found')
    return item
  }

  function session() {
    return {
      patientId: PATIENT_ID,
      name: { given: [db.demographics.firstName], family: db.demographics.lastName },
      idleExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
    }
  }

  /** The old portal's slot finder: open times in 15-minute steps, 8 AM to 4:30 PM, lunch closed. */
  function slotsFor(date: string, facilityId: string, providerId: string, minutes: number, ignoreId?: string): Slot[] {
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay()
    if (wd === 0 || wd === 6) return []
    const offset = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${todayIn(TZ)}T12:00:00Z`)) / 86_400_000)
    if (offset < 0 || offset > 30) return []
    const booked = db.appointments.filter((a) => a.status === 'booked' && a.provider.id === providerId && a.id !== ignoreId)
    const slots: Slot[] = []
    for (let m = 8 * 60; m + minutes <= 16 * 60 + 30; m += 15) {
      if (m >= 12 * 60 && m < 13 * 60) continue
      if ((offset * 7 + m / 15 + providerId.charCodeAt(providerId.length - 1)) % 4 === 0) continue
      const startAt = facilityInstant(offset, Math.floor(m / 60), m % 60)
      if (Date.parse(startAt) <= Date.now()) continue
      const endAt = addMinutes(startAt, minutes)
      if (booked.some((a) => a.startAt < endAt && startAt < a.endAt)) continue
      slots.push({ startAt, providerId, facilityId })
    }
    return slots
  }

  function buildAppointment(input: AppointmentRequest, id: string): Appointment {
    const facility = find(FACILITIES, input.facilityId)
    const provider = find(PROVIDERS, input.providerId)
    const category = find(CATEGORIES, input.categoryId)
    const free = slotsFor(todayIn(TZ, new Date(input.startAt)), facility.id, provider.id, input.durationMinutes, id)
    if (!free.some((s) => s.startAt === input.startAt)) throw problem(409, 'booking-conflict', 'Booking conflict')
    return {
      id,
      startAt: input.startAt,
      endAt: addMinutes(input.startAt, input.durationMinutes),
      status: 'booked',
      category: ref(category),
      reason: input.reason,
      mode: category.mode,
      provider: ref(provider),
      facility,
      reminder: input.reminder,
      canReschedule: true,
      canCancel: true,
      videoRoomOpen: false,
    }
  }

  function textReport(): string {
    const d = db.demographics
    return [
      'PATIENT HEALTH REPORT (synthetic sample)',
      `Patient: ${d.firstName} ${d.lastName}`,
      '',
      'Medical problems:',
      ...db.healthIssues.map((h) => `  - ${h.title} (${h.diagnosis})${h.endDate ? ' - resolved' : ''}`),
      'Allergies:',
      ...db.allergies.map((a) => `  - ${a.title}: ${a.reaction}`),
      'Prescriptions:',
      ...db.prescriptions.map((p) => `  - ${p.drug}`),
      'Immunizations:',
      ...db.immunizations.map((i) => `  - ${i.vaccine}, ${i.administeredDate}`),
    ].join('\n')
  }

  const api: PortalApi = {
    signIn: (username, password) =>
      wait(() => {
        if (!username.trim() || !password) throw problem(422, 'validation-failed', 'Validation failed')
        // Mock rule: any username works; the password "wrong-password" shows the failed sign-in state.
        if (password === 'wrong-password') throw problem(401, 'unauthenticated', 'Unauthenticated')
        signedIn = true
        return session()
      }),
    signOut: () =>
      wait(() => {
        signedIn = false
      }),
    refreshSession: () => authed(session),
    requestUsernameReminder: () => wait(() => undefined),
    requestPasswordReset: () => wait(() => undefined),
    getReferenceLists: () => wait(() => structuredClone(LISTS)),
    register: () => wait(() => undefined),
    downloadRegistrationSummary: (input) =>
      wait(() => {
        const b = input.basic
        const text = [
          'REGISTRATION SUMMARY (synthetic sample)',
          `Name: ${b.firstName} ${b.middleName} ${b.lastName}`,
          `Date of birth: ${b.birthDate}`,
          `Address: ${b.address}, ${b.city}, ${b.state} ${b.postalCode}`,
          `Email: ${b.email}`,
          '',
          'Your account opens after the practice approves your registration.',
        ].join('\n')
        return new Blob([text], { type: 'text/plain' })
      }),

    getAlerts: () =>
      authed(() => {
        const today = todayIn(TZ)
        const next = db.appointments
          .filter((a) => a.status === 'booked' && Date.parse(a.endAt) > Date.now())
          .sort((a, b) => a.startAt.localeCompare(b.startAt))
        return next.slice(0, 3).map((a) => ({ appointmentId: a.id, startAt: a.startAt, timeZone: a.facility.timeZone, today: todayIn(TZ, new Date(a.startAt)) === today }))
      }),

    getDemographics: () => authed(() => db.demographics),
    updateDemographics: (input) =>
      authed(() => {
        db.demographics = input
        return db.demographics
      }),
    changePassword: ({ currentPassword }) =>
      authed(() => {
        if (currentPassword === 'wrong-password') {
          throw { ...problem(422, 'validation-failed', 'Validation failed'), errors: [{ in: 'body', pointer: '/currentPassword', code: 'incorrect' }] }
        }
      }),
    getSignature: () => authed(() => signature),
    saveSignature: (image) =>
      authed(() => {
        if (!image.startsWith('data:image/png')) throw problem(422, 'validation-failed', 'Validation failed')
        signature = { image, savedAt: new Date().toISOString() }
        return signature
      }),

    listAppointments: () => authed(() => [...db.appointments].sort((a, b) => a.startAt.localeCompare(b.startAt))),
    getAppointment: (id) => authed(() => find(db.appointments, id)),
    cancelAppointment: (id) =>
      authed(() => {
        const a = find(db.appointments, id)
        if (!a.canCancel) throw problem(409, 'invalid-state-transition', 'Invalid state transition')
        Object.assign(a, { status: 'cancelled', canCancel: false, canReschedule: false })
        return a
      }),
    listFacilities: () => authed(() => FACILITIES),
    listCategories: () => authed(() => CATEGORIES),
    listProviders: (facilityId) => authed(() => PROVIDERS.filter((p) => p.facilityIds.includes(facilityId))),
    findSlots: ({ date, facilityId, providerId, durationMinutes }) => authed(() => slotsFor(date, facilityId, providerId, durationMinutes)),
    bookAppointment: (input) =>
      authed(() => {
        const a = buildAppointment(input, newId())
        db.appointments.push(a)
        return a
      }),
    rescheduleAppointment: (id, input) =>
      authed(() => {
        const old = find(db.appointments, id)
        if (!old.canReschedule) throw problem(409, 'invalid-state-transition', 'Invalid state transition')
        Object.assign(old, buildAppointment(input, id))
        return old
      }),
    getVisitSummary: (id) => authed(() => find(db.visitSummaries, id)),
    joinVideoVisit: (id) =>
      authed(() => {
        const a = find(db.appointments, id)
        if (a.mode !== 'video' || !a.videoRoomOpen) throw problem(409, 'invalid-state-transition', 'Invalid state transition')
        // Self-hosted Jitsi (FRS 3.8). The room name is opaque and per visit.
        return { joinUrl: `https://meet.company-domain.invalid/${a.id.replaceAll('-', '')}` }
      }),

    listMessages: (folder) => authed(() => ({ items: db.messages.filter((m) => m.folder === folder).sort((a, b) => b.sentAt.localeCompare(a.sentAt)) })),
    markMessageRead: (id) =>
      authed(() => {
        find(db.messages, id).read = true
      }),
    sendMessage: (input) =>
      authed(() => {
        const to = find(PROVIDERS, input.recipientId)
        const m: Message = { id: newId(), folder: 'sent', subject: input.subject, from: db.me, to: ref(to), sentAt: new Date().toISOString(), read: true, body: input.body }
        db.messages.push(m)
        return m
      }),
    moveMessagesToTrash: (ids) =>
      authed(() => {
        for (const id of ids) find(db.messages, id).folder = 'trash'
      }),
    deleteMessagesFromTrash: (ids) =>
      authed(() => {
        db.messages = db.messages.filter((m) => !(ids.includes(m.id) && m.folder === 'trash'))
      }),
    listRecipients: () => authed(() => PROVIDERS),

    listResults: () => authed(() => [...db.results].sort((a, b) => b.orderedAt.localeCompare(a.orderedAt))),
    getResult: (id) => authed(() => find(db.results, id)),
    listHealthIssues: () => authed(() => db.healthIssues),
    getHealthIssue: (id) => authed(() => find(db.healthIssues, id)),
    listAllergies: () => authed(() => db.allergies),
    getAllergy: (id) => authed(() => find(db.allergies, id)),
    listImmunizations: () => authed(() => [...db.immunizations].sort((a, b) => b.administeredDate.localeCompare(a.administeredDate))),
    getImmunization: (id) => authed(() => find(db.immunizations, id)),
    listVitals: () => authed(() => db.vitals),

    listPrescriptions: () => authed(() => db.prescriptions),
    requestRefill: ({ prescriptionIds, pharmacyId, message }) =>
      authed(() => {
        if (!prescriptionIds.length || !message.trim()) throw problem(422, 'validation-failed', 'Validation failed')
        const pharmacy = find(PHARMACIES, pharmacyId)
        const chosen = prescriptionIds.map((id) => find(db.prescriptions, id))
        if (chosen.some((p) => !p.refillable || p.requestStatus === 'requested')) throw problem(409, 'invalid-state-transition', 'Invalid state transition')
        for (const p of chosen) p.requestStatus = 'requested'
        const request: RefillRequest = { id: newId(), prescriptions: chosen.map((p) => ({ id: p.id, drug: p.drug })), pharmacy, message: message.trim(), requestedAt: new Date().toISOString() }
        refillRequests.push(request)
        return request
      }),
    getRefillRequest: (id) => authed(() => find(refillRequests, id)),

    listBills: () => authed(() => db.bills),
    makePayment: ({ billId, amount, paymentToken }) =>
      authed(() => {
        const bill = find(db.bills, billId)
        if (!paymentToken || cents(amount) <= 0 || cents(amount) > cents(bill.amountDue)) throw problem(422, 'validation-failed', 'Validation failed')
        bill.amountDue = usd(((cents(bill.amountDue) - cents(amount)) / 100).toFixed(2))
        bill.patientPaid = usd(((cents(bill.patientPaid) + cents(amount)) / 100).toFixed(2))
        bill.adjustments.push({ date: todayIn(TZ), description: 'Patient payment (portal)', amount: usd(`-${amount.value}`) })
        return { id: newId(), amount, paidAt: new Date().toISOString(), confirmationNumber: `PAY-${String(nextId).padStart(6, '0')}` }
      }),

    listDocuments: (source) => authed(() => db.documents.filter((d) => d.source === source).sort((a, b) => b.date.localeCompare(a.date))),
    uploadDocument: (file) =>
      authed(() => {
        if (file.size > 10 * 1024 * 1024) throw problem(413, 'payload-too-large', 'Payload too large')
        if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) throw problem(415, 'unsupported-media-type', 'Unsupported media type')
        const doc: PortalDocument = { id: newId(), name: file.name, date: todayIn(TZ), source: 'patient', contentType: file.type, sizeBytes: file.size }
        db.documents.push(doc)
        return doc
      }),
    downloadDocument: (id) =>
      authed(() => `${find(db.documents, id).name}\n\nSample document (synthetic data).`).then((text) => new Blob([text], { type: 'text/plain' })),

    listTemplates: () => authed(() => db.templates),
    getTemplate: (id) => authed(() => find(db.templates, id)),
    saveTemplate: (id, { values, signature: sig }) =>
      authed(() => {
        const t = find(db.templates, id)
        if (t.reviewStatus === 'waiting-review' || t.reviewStatus === 'accepted') throw problem(409, 'invalid-state-transition', 'Invalid state transition')
        t.values = { ...values }
        if (sig) {
          t.signature = sig
          t.signed = true
        }
        return t
      }),
    sendTemplateForReview: (id) =>
      authed(() => {
        const t = find(db.templates, id)
        if (!t.signed) throw { ...problem(422, 'business-rule-violation', 'Business rule violation'), errors: [{ in: 'body', pointer: '/signature', code: 'required' }] }
        Object.assign(t, { reviewStatus: 'waiting-review' })
        return t
      }),
    deleteTemplateDraft: (id) =>
      authed(() => {
        const t = find(db.templates, id)
        if (t.reviewStatus === 'waiting-review' || t.reviewStatus === 'accepted') throw problem(409, 'invalid-state-transition', 'Invalid state transition')
        t.values = {}
        delete t.signature
        t.signed = false
        return t
      }),

    getPatientReport: () =>
      authed(() => {
        const d = db.demographics
        return {
          generatedAt: new Date().toISOString(),
          patient: { name: `${d.firstName} ${d.middleName} ${d.lastName}`, birthDate: '1984-07-19', sex: 'Female', address: `${d.address}, ${d.city}, ${d.state} ${d.postalCode}`, phone: d.mobilePhone },
          issues: db.healthIssues,
          allergies: db.allergies,
          prescriptions: db.prescriptions,
          immunizations: db.immunizations,
          vitals: db.vitals[db.vitals.length - 1] ?? null,
        }
      }),
    downloadReport: (kind) =>
      authed(() => `${kind.toUpperCase()} export (mock)\n\n${textReport()}`).then((text) => new Blob([text], { type: 'text/plain' })),
  }
  return api
}
