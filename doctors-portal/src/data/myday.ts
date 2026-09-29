/**
 * S-06-01 · My Day — the day plan, the patient lists and the attention list.
 *
 * Everything here is DERIVED from the §8 sample-data kit and the records in
 * `clinical.ts`. Nothing is invented (§8.6), with one labelled exception noted
 * at its definition: `WARD_EXTENSIONS`.
 *
 * On OPD. §8.6 says "18 in clinic, 4 seen", but the §8 cast cannot fill
 * eighteen outpatient slots without inventing patients, which §8 forbids. The
 * OPD list is therefore the MODELLED clinic rows, less anyone who is in a bed
 * (`opdRows`) — six today — and the figure 18 does not appear on screen.
 */

import type { ConfidenceBand } from '@/atlas/confidence'
import type { PersonaId } from '@/atlas/personas'

import {
  CLINIC_LIST,
  COSIGN_QUEUE,
  DISCHARGE_BOARD,
  INPATIENTS,
  REFERRALS,
  RESULTS,
  TELECONSULT_QUEUE,
  RISK_STRIPS,
  TIMELINE,
  VITALS,
  encounter,
  encounterForPatient,
  ordersFor,
  timelineFor,
} from './clinical'
import type { TeleRow } from './clinical'
import { TYPE_LABEL, inpatientRows, isAdmittedHere, opdRows, pendingAdmissions } from './admissions'
import type { Admissions } from './admissions'
import { NOW, formatTime, minutesAgo } from './format'
import { maybePatient, patient } from './kit'
import { NETWORK_TODAY, PAGING_LOG, STROKE_CASES, STROKE_TASKS, TELESTROKE_QUEUE } from './stroke'

// ═══════════════════════════════════════════════════════════ The day plan

export interface DayBlock {
  id: string
  /** The clock face, large type. */
  at: Date
  /** Ends, where the activity occupies a span rather than a moment. */
  until?: Date
  /** Medium type. Short — one or two words wherever possible. */
  title: string
  /**
   * ONE line. The brief is explicit: no long descriptions, no unnecessary
   * labels. Numbers that matter are marked up by `emphasis`.
   */
  summary: string
  /** Substrings of `summary` rendered in the priority ink rather than quietly. */
  emphasis?: { text: string; tone: 'critical' | 'warning' | 'pending' }[]
  icon: string
  /** Where tapping the block goes. */
  to: string
  /** Set where the block's summary is AI-derived, so it can carry ◆. */
  ai?: string
  band?: ConfidenceBand
}

/** What the day plan reads from the session, so a count follows what was done in it. */
export interface DayState {
  admissions?: Admissions
  /** Result ids acknowledged this session. */
  acknowledgements?: Record<string, unknown>
  /** Co-sign queue items actioned this session. */
  coSigned?: Record<string, unknown>
}


/** The session opened 70 minutes before the fixed moment — 07:30. */
const SHIFT_START = minutesAgo(70)

function at(hour: number, minute = 0): Date {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hour, minute)
}

/** The clinical day — P-04 and P-05. */
function clinicalDay(persona: PersonaId, state: DayState): DayBlock[] {
  const { admissions = {}, acknowledgements = {}, coSigned = {} } = state
  const toReview = RESULTS.filter((r) => !r.acknowledged && acknowledgements[r.id] === undefined)
  const critical = toReview.filter((r) => r.critical)
  const inpatients = inpatientRows(admissions)
  const clinic = opdRows(admissions)
  const attention = inpatients.filter((r) => r.risk === 'HIGH').length
  const followUps = clinic.filter((c) => isFollowUp(c.patientId)).length
  const tele = encounter('E-118430')
  const cosign = COSIGN_QUEUE.filter((c) => coSigned[c.id] === undefined)
  const discharges = DISCHARGE_BOARD.filter((d) => d.likelihood === 'Today')
  const canSign = persona === 'P-04'

  const blocks: DayBlock[] = [
    {
      id: 'brief',
      at: SHIFT_START,
      title: 'AI morning brief',
      summary: `${toReview.length} results changed · ${critical.length} critical`,
      emphasis: [
        { text: `${toReview.length} results changed`, tone: 'warning' },
        { text: `${critical.length} critical`, tone: 'critical' },
      ],
      icon: 'Sunrise',
      to: '/results/inbox',
      ai: 'AI-212',
      band: 'HIGH',
    },
    {
      id: 'opd-am',
      at: at(8, 0),
      until: at(9, 0),
      title: 'OPD',
      /*
       * The brief's own format: "6 patients · 2 new · 4 follow-ups". Not the
       * seen count, not the next token — the home screen says what the block
       * IS; the OPD list says where it has got to.
       */
      summary: `${clinic.length} patients · ${clinic.length - followUps} new · ${followUps} follow-ups`,
      icon: 'Stethoscope',
      to: '/op-queue',
    },
    {
      id: 'tele',
      at: tele.startedAt,
      title: 'Teleconsult',
      summary: `1 patient · ${tele.department}`,
      icon: 'Video',
      to: '/tele/queue',
    },
    {
      id: 'round',
      at: at(10, 30),
      title: 'Ward round',
      summary: `${inpatients.length} patients · ${attention} need attention`,
      emphasis: [{ text: `${attention} need attention`, tone: 'warning' }],
      icon: 'BedDouble',
      to: '/ip/patients',
    },
    {
      id: 'cosign',
      at: at(12, 0),
      title: canSign ? 'Co-sign' : 'Awaiting co-sign',
      summary: `${cosign.length} pending`,
      icon: 'PenLine',
      to: '/clinician/cosign',
    },
    {
      id: 'opd-pm',
      at: at(14, 0),
      until: at(16, 0),
      title: 'OPD',
      summary: 'afternoon session',
      icon: 'Stethoscope',
      to: '/op-queue',
    },
    {
      id: 'discharge',
      at: at(16, 30),
      title: 'Discharge round',
      summary: `${discharges.length} predicted today`,
      icon: 'DoorOpen',
      to: '/discharge/board',
      ai: 'AI-610',
      band: 'MED',
    },
  ]

  // A resident does not run a co-sign session; theirs is a wait, not a task.
  return blocks
}

/** The stroke day — P-35, P-36, P-38. */
function strokeDay(): DayBlock[] {
  const activeCases = STROKE_CASES.filter((c) => c.status === 'active')
  const active = activeCases.length

  return [
    {
      id: 'brief',
      at: SHIFT_START,
      title: 'Overnight brief',
      summary: `${NETWORK_TODAY.activations} activations · DTN median ${NETWORK_TODAY.dtnMedianMin} min`,
      icon: 'Sunrise',
      to: '/stroke/wall',
    },
    {
      id: 'stroke-review',
      at: at(8, 0),
      title: 'Stroke review',
      summary: `${active} active ${active === 1 ? 'case' : 'cases'}`,
      emphasis: [{ text: `${active} active`, tone: 'critical' }],
      icon: 'Brain',
      to: '/stroke/wall',
    },
    {
      id: 'telestroke',
      at: at(9, 30),
      title: 'Telestroke queue',
      summary: 'requests from the spokes',
      icon: 'Video',
      to: '/stroke/telestroke/queue',
    },
    {
      id: 'sites',
      at: at(11, 0),
      title: 'Spoke readiness',
      summary: '4 sites · CT and cover',
      icon: 'Network',
      to: '/stroke/network/sites',
    },
    {
      id: 'registry',
      at: at(15, 0),
      title: 'Registry',
      summary: 'mRS-90 follow-up calls',
      icon: 'ClipboardList',
      to: '/stroke/registry',
    },
  ]
}

const STROKE_PERSONAS: PersonaId[] = ['P-35', 'P-36', 'P-38']

/** The stroke network's clinicians, whose day is the network's rather than a clinic's and a ward's. */
export function isStrokePersona(persona: PersonaId): boolean {
  return STROKE_PERSONAS.includes(persona)
}

export function dayPlanFor(persona: PersonaId, state: DayState = {}): DayBlock[] {
  if (STROKE_PERSONAS.includes(persona)) return strokeDay()
  return clinicalDay(persona, state)
}

/** The block covering `NOW` — rendered as in progress. */
export function currentBlock(blocks: DayBlock[]): DayBlock | undefined {
  return blocks.find((b) => {
    const end = b.until ?? new Date(b.at.getTime() + 30 * 60000)
    return NOW >= b.at && NOW < end
  })
}

// ═══════════════════════════════════════════════════════ My patients — lists

/**
 * One row of a My Day patient list: the name, one kind tag and — only when
 * it says something — one status tag. Nothing else: vitals, results and the
 * reason for admission are one tap away, on the patient's record.
 */
/**
 * A row's status, drawn as a picture first and a word second: a coloured icon,
 * then a small secondary word. Colour only where it means something — red
 * critical, amber needs attention, blue normal — and neutral otherwise.
 */
export interface RowMark {
  label: string
  icon: string
  tone: 'critical' | 'attention' | 'normal' | 'neutral'
  /**
   * The icon alone, for a state that would otherwise repeat the same word down
   * the list (Follow-up, Seen). The word stays in the tooltip and the row's
   * accessible name, so it is never the icon's alone to carry.
   */
  iconOnly?: boolean
}

export interface PatientListRow {
  patientId: string
  /**
   * Where the patient is — OPD, Ward, ICU, ED, or a telestroke spoke — as the
   * icon that leads the row. The label is read out and shown on hover.
   */
  place: { icon: string; label: string }
  /** Quiet text after the name — a bed, a spoke. */
  detail?: string
  /** What kind of visit this is, in OPD: New patient or Follow-up. */
  kind?: RowMark
  /** One status at most, the one that matters most. */
  status?: RowMark
  /** Already seen: the row goes quiet. */
  done?: boolean
}

const FOLLOW_UP: RowMark = { label: 'Follow-up', icon: 'History', tone: 'neutral', iconOnly: true }
const NEW_PATIENT: RowMark = { label: 'New patient', icon: 'UserPlus', tone: 'normal' }

/**
 * A clinic row is a follow-up where the patient's documented scenario says so,
 * or where the record already holds a prior encounter. Everything else is new.
 */
export function isFollowUp(patientId: string): boolean {
  const s = patient(patientId).scenario.toLowerCase()
  if (s.includes('follow-up') || s.includes('chronic')) return true
  return (TIMELINE[patientId]?.length ?? 0) > 0
}

/** A teleconsult's row: the video icon for its place, and when the call is — or that it will be a phone call. */
const TELECONSULT_PLACE: PatientListRow['place'] = { icon: 'Video', label: 'Teleconsult' }

function teleStatus(t: TeleRow): RowMark {
  return t.videoReady
    ? { label: formatTime(t.scheduledAt), icon: 'Clock', tone: 'neutral' }
    : { label: 'Telephone only', icon: 'Phone', tone: 'attention' }
}

/**
 * Today's OPD, who is next first. A patient being admitted leads, because the
 * hospital is acting on them now; then the waiting room, then those still to
 * arrive, then those already seen.
 *
 * The teleconsult queue belongs here too — they are today's outpatients, seen
 * by video. A patient on it carries the video icon instead of the person, and
 * the call's time as their status; one who is on both lists appears once, as
 * the teleconsult. Anyone in a bed stays on Inpatients, so the two lists remain
 * a partition.
 */
export function opdList(admissions: Admissions = {}): PatientListRow[] {
  const teleFor = (patientId: string) => TELECONSULT_QUEUE.find((t) => t.patientId === patientId)
  const inBed = new Set(inpatientRows(admissions).map((r) => r.patientId))
  const rank = (patientId: string, status: string) =>
    admissions[patientId]
      ? 0
      : teleFor(patientId)
        ? 2.5
        : ({ Waiting: 1, 'In room': 2, 'Not arrived': 3, Seen: 4 } as Record<string, number>)[status] ?? 5

  const clinic = opdRows(admissions)
    .slice()
    .sort((a, b) => rank(a.patientId, a.status) - rank(b.patientId, b.status) || a.bookedAt.getTime() - b.bookedAt.getTime())
    .map<PatientListRow>((r) => {
      const tele = admissions[r.patientId] ? undefined : teleFor(r.patientId)
      return {
        patientId: r.patientId,
        place: tele ? TELECONSULT_PLACE : { icon: 'UserRound', label: 'OPD' },
        kind: isFollowUp(r.patientId) ? FOLLOW_UP : NEW_PATIENT,
        status: admissions[r.patientId]
          ? { label: 'Admission in progress', icon: 'Hourglass', tone: 'attention' }
          : tele
            ? teleStatus(tele)
            : r.status === 'Waiting'
              ? { label: 'Waiting', icon: 'Clock', tone: 'attention' }
              : r.status === 'In room'
                ? { label: 'In room', icon: 'DoorOpen', tone: 'normal' }
                : r.status === 'Seen'
                  ? { label: 'Seen', icon: 'Check', tone: 'neutral', iconOnly: true }
                  : { label: 'Not arrived', icon: 'CircleDashed', tone: 'neutral' },
        done: !admissions[r.patientId] && !tele && r.status === 'Seen',
      }
    })

  // Teleconsults booked for someone not already in the clinic list, and not in a bed.
  const listed = new Set(clinic.map((r) => r.patientId))
  const teleOnly = TELECONSULT_QUEUE.filter((t) => !listed.has(t.patientId) && !inBed.has(t.patientId))
    .slice()
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
    .map<PatientListRow>((t) => ({
      patientId: t.patientId,
      place: TELECONSULT_PLACE,
      kind: isFollowUp(t.patientId) ? FOLLOW_UP : NEW_PATIENT,
      status: teleStatus(t),
    }))

  return [...clinic, ...teleOnly]
}

/** Where a bed is, in the three words the Inpatients screen filters by, and the icon each gets. */
function placeOf(bed: string | null): PatientListRow['place'] {
  if (bed?.startsWith('ICU')) return { icon: 'HeartPulse', label: 'ICU' }
  if (bed?.startsWith('ED')) return { icon: 'Ambulance', label: 'ED' }
  return { icon: 'BedDouble', label: 'Ward' }
}

/**
 * Everyone in a bed, in the Inpatients screen's order. Ward, ICU or ED is the
 * row's icon and its bed, so it carries no location tag as well. One status
 * tag at most, and the one that matters most wins: a high risk before a new
 * admission before a discharge.
 */
export function inpatientList(admissions: Admissions = {}): PatientListRow[] {
  const goingHome = new Set(DISCHARGE_BOARD.filter((d) => d.likelihood === 'Today').map((d) => d.patientId))
  return inpatientRows(admissions).map<PatientListRow>((r) => ({
    patientId: r.patientId,
    place: placeOf(r.bed),
    detail: r.bed ?? undefined,
    status:
      r.risk === 'HIGH'
        ? { label: 'High risk', icon: 'TriangleAlert', tone: 'critical' }
        : isAdmittedHere(r.patientId, admissions)
          ? { label: 'Admitted today', icon: 'LogIn', tone: 'neutral' }
          : goingHome.has(r.patientId)
            ? { label: 'Discharge today', icon: 'LogOut', tone: 'neutral' }
            : undefined,
  }))
}

/** The stroke network's own list: the spokes' requests waiting on a telestroke consult. */
export function telestrokeList(): PatientListRow[] {
  return TELESTROKE_QUEUE.map<PatientListRow>((r) => ({
    patientId: r.patientId,
    place: { icon: 'Video', label: 'Telestroke' },
    detail: `${r.site} · NIHSS ${r.nihss}`,
    status:
      r.status === 'In session'
        ? { label: 'In session', icon: 'CircleDot', tone: 'normal' }
        : { label: 'Waiting', icon: 'Clock', tone: 'attention' },
  }))
}

// ═══════════════════════════════════════════════════ Pending today

/**
 * The third question the calm home now answers: what must I finish before I
 * leave? Documentation and sign-offs only — the things that are the doctor's
 * to close, not things to read. Results are deliberately absent: a critical
 * one interrupts through Attention in Needs Action; the rest live in Results.
 */
export interface FinishItem {
  key: string
  label: string
  count: number
  /** A second count worth naming — "1 urgent". */
  detail?: string
  icon: string
  to: string
  urgency?: Urgency
}

export function toFinishFor(
  persona: PersonaId,
  state: {
    notes: Record<string, { status: string }>
    coSigned: Record<string, unknown>
    triagedReferrals: Record<string, unknown>
    /** Keyed by patient id; `'unattached'` holds the doctor's own to-do notes, which are never "to sign". */
    voiceNotes: Record<string, { status: string }[]>
  },
): FinishItem[] {
  if (STROKE_PERSONAS.includes(persona)) {
    const openTasks = STROKE_TASKS.filter((t) => t.column !== 'Done')
    const blocked = STROKE_TASKS.filter((t) => t.column === 'Blocked').length
    const unacked = PAGING_LOG.filter((p) => p.ackAt === null)
    const stroke: FinishItem[] = [
      {
        key: 'tasks',
        label: 'Case tasks open',
        count: openTasks.length,
        detail: blocked > 0 ? `${blocked} blocked` : undefined,
        icon: 'ClipboardList',
        to: '/stroke/case/0141/tasks',
        urgency: blocked > 0 ? 'warning' : 'pending',
      },
      {
        key: 'pages',
        label: 'Pages unacknowledged',
        count: unacked.length,
        detail: unacked[0]?.role,
        icon: 'Users',
        to: '/stroke/case/0141/team',
        urgency: unacked.length > 0 ? 'critical' : undefined,
      },
    ]
    return stroke.filter((i) => i.count > 0)
  }

  /** A note is still to write until the record holds a signed note for that patient's encounter. */
  const noteSigned = (patientId: string) => {
    const enc = encounterForPatient(patientId)
    return enc !== undefined && state.notes[enc.id]?.status === 'signed'
  }
  const roundNotes = INPATIENTS.filter(
    (r) => r.pending.some((p) => /note/i.test(p)) && !noteSigned(r.patientId),
  ).length
  const cosign = COSIGN_QUEUE.filter((c) => state.coSigned[c.id] === undefined).length
  /**
   * A dictated note is the doctor's to close only while it is an unsigned
   * draft about a patient. One row per patient, opening that patient's notes,
   * so signing it there is what makes the row go. To-do notes are not
   * patient documentation and live in their own card.
   */
  const dictatedRows: FinishItem[] = Object.entries(state.voiceNotes).flatMap(([patientId, list]) => {
    if (patientId === 'unattached') return []
    const drafts = list.filter((n) => n.status === 'draft').length
    const p = maybePatient(patientId)
    if (drafts === 0 || !p) return []
    return [
      {
        key: `dictated-${patientId}`,
        label: drafts === 1 ? 'Dictated note to sign' : 'Dictated notes to sign',
        count: drafts,
        detail: p.name,
        icon: 'Mic',
        to: `/patient/${p.uhid}/notes`,
        urgency: 'pending' as const,
      },
    ]
  })
  const summaries = INPATIENTS.filter((r) => r.pending.includes('Discharge summary')).length
  const referrals = REFERRALS.filter((r) => state.triagedReferrals[r.id] === undefined)
  const urgentReferrals = referrals.filter((r) => r.triage === 'Urgent').length

  const items: FinishItem[] = [
    { key: 'notes', label: 'Ward round notes due', count: roundNotes, icon: 'PenLine', to: '/ip/patients', urgency: 'pending' },
    { key: 'cosign', label: 'Notes to co-sign', count: cosign, icon: 'Signature', to: '/clinician/cosign', urgency: 'pending' },
    ...dictatedRows,
    { key: 'summary', label: 'Discharge summary to sign', count: summaries, icon: 'FileText', to: '/discharge/board', urgency: 'warning' },
    {
      key: 'referrals',
      label: 'Referrals to review',
      count: referrals.length,
      detail: urgentReferrals > 0 ? `${urgentReferrals} urgent` : undefined,
      icon: 'Inbox',
      to: '/referrals',
      urgency: urgentReferrals > 0 ? 'warning' : 'pending',
    },
  ]
  return items.filter((i) => i.count > 0)
}

// ══════════════════════════════════════════════ Needs my attention (3–5 max)

/** The brief's three colour rules, as a closed set. */
export type Urgency = 'critical' | 'warning' | 'pending'

export interface AttentionItem {
  id: string
  patientId: string
  urgency: Urgency
  /** Short — "Critical lab report identified", "New deterioration". */
  reason: string
  /** The detail line, shown ONLY in the Quick-Panel, never on the home screen. */
  detail: string
  /** Set where the ranking or the finding is AI-derived. */
  ai?: string
  band?: ConfidenceBand
  /** Deterministic order, for the one-click reversal AI-613 requires. */
  since: Date
}

const URGENCY_ORDER: Record<Urgency, number> = { critical: 0, warning: 1, pending: 2 }

/**
 * Derived, ranked, and capped at five — "List only 3–5 items max". Anything
 * that does not make the cut is still on the Inpatients screen, from the nav.
 */
export function attentionFor(
  persona: PersonaId,
  acknowledged: Record<string, unknown> = {},
  admissions: Admissions = {},
): AttentionItem[] {
  if (STROKE_PERSONAS.includes(persona)) {
    return STROKE_CASES.filter((c) => c.status === 'active').map((c) => ({
      id: `stroke-${c.id}`,
      patientId: c.patientId,
      urgency: 'critical' as Urgency,
      reason: 'Active stroke case',
      detail: `${c.caseNo} · ${c.originFacility} → ${c.destinationFacility}`,
      ai: 'AI-209',
      band: 'HIGH' as ConfidenceBand,
      since: minutesAgo(34),
    }))
  }

  const items: AttentionItem[] = []

  // 🔴 A critical value that no named clinician has answered for yet.
  for (const r of RESULTS) {
    if (!r.critical || r.acknowledged || acknowledged[r.id]) continue
    items.push({
      id: `result-${r.id}`,
      patientId: r.patientId,
      urgency: 'critical',
      reason: 'Critical lab report identified',
      detail: `${r.test} ${r.value} ${r.unit} · ${r.delta ?? 'no prior'} · unacknowledged ${r.unackMinutes ?? 0} min`,
      ai: 'AI-212',
      band: r.band,
      since: r.reportedAt,
    })
  }

  // 🟠 Deterioration the model is confident about.
  for (const row of INPATIENTS) {
    if (row.risk !== 'HIGH') continue
    if (items.some((i) => i.patientId === row.patientId)) continue
    const strip = RISK_STRIPS[row.patientId]
    items.push({
      id: `risk-${row.patientId}`,
      patientId: row.patientId,
      urgency: 'warning',
      reason: 'New deterioration',
      detail: `${strip?.score ?? row.reason} · ${strip?.trend ?? ''} · ${row.bed}`.trim(),
      ai: 'AI-201',
      band: 'HIGH',
      since: row.chronologicalAt,
    })
  }

  /*
   * 🟠 A critical admission still waiting on the hospital. Orange, like the
   * patient's chip: it is being handled, so it never outranks a critical
   * result that nobody has answered for.
   */
  for (const a of pendingAdmissions(admissions)) {
    if (a.priority !== 'critical') continue
    if (items.some((i) => i.patientId === a.patientId)) continue
    items.push({
      id: `admission-${a.patientId}`,
      patientId: a.patientId,
      urgency: 'warning',
      reason: 'Admission in progress',
      detail: `${TYPE_LABEL[a.type]} · Critical · ${a.bed ? `bed ${a.bed} allocated` : 'waiting for bed'}`,
      since: NOW,
    })
  }

  // 🟡 A model that cannot score, saying so — never a zero (§4.5).
  for (const row of INPATIENTS) {
    if (row.risk !== 'ABSTAIN') continue
    items.push({
      id: `abstain-${row.patientId}`,
      patientId: row.patientId,
      urgency: 'pending',
      reason: 'Cannot assess',
      detail: row.abstainReason ?? 'Not enough charted data to score.',
      ai: 'AI-201',
      since: row.chronologicalAt,
    })
  }

  // 🟡 A note waiting on a signature.
  for (const cs of COSIGN_QUEUE) {
    if (items.some((i) => i.patientId === cs.patientId)) continue
    items.push({
      id: `cosign-${cs.id}`,
      patientId: cs.patientId,
      urgency: 'pending',
      reason: 'Co-sign waiting',
      detail: `${cs.documentKind} by ${cs.authoredByPersona}`,
      since: cs.authoredAt,
    })
  }

  return items
    .sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] || b.since.getTime() - a.since.getTime())
    .slice(0, 5)
}

/** The reversal AI-613's guardrail requires: newest first, no model involved. */
export function attentionChronological(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => b.since.getTime() - a.since.getTime())
}

// ═════════════════════════════════════════════ The card / delta wire contract

export type DeltaType = 'timer' | 'lab-critical' | 'imaging' | 'vitals' | 'med' | 'note'

/** Server-side priority, so the client stays light. */
const DELTA_PRIORITY: Record<DeltaType, number> = {
  timer: 0,
  'lab-critical': 1,
  imaging: 2,
  vitals: 3,
  med: 4,
  note: 5,
}

export interface Delta {
  type: DeltaType
  /** The card token — "BP 170/98 ↑", "CT ▲". Short. */
  shortLabel: string
  /** The Quick-Panel line. */
  label: string
  icon: string
  /** ISO. */
  ts: string
  value?: string
  priority: number
  /** Only the Quick-Panel reads these. */
  detail?: string
  trend?: { at: Date; value: number }[]
  ai?: string
}

/**
 * The payload shape as specified, in snake_case because it IS the wire format.
 * `status_color_hex` is carried for contract fidelity, but the UI resolves its
 * token from `status_category` and never reads the hex — otherwise the theme
 * toggle could not repaint it.
 */
export interface MyDayCard {
  patient_id: string
  name: string
  mrn: string
  room: string
  scheduled_time: string
  status_category: 'critical' | 'moderate' | 'normal' | 'routine'
  status_color_hex: string
  lastSeenByClinician: string
  /** Pre-ordered by priority by the server. */
  delta_summary: Delta[]
  active_timers: { name: string; expires: string }[]
  /**
   * Left undefined for every patient. The §8 cast carries no photographs;
   * inventing patient faces for a mockup is a liability, not a feature.
   */
  thumbnail_url?: string
  quick_actions: { markSeen: string; openChart: string; callNurse: string }
}

export const STATUS_HEX: Record<MyDayCard['status_category'], string> = {
  critical: '#D64545',
  moderate: '#E6A23C',
  normal: '#3A8DFF',
  routine: '#FFFFFF',
}

/**
 * §8 carries no telephone numbers. These exist so the `tel:` affordance is real
 * and testable on a phone; they are NOT part of the sample data kit.
 */
const WARD_EXTENSIONS: Record<string, string> = {
  '4B': '+918049001042',
  '2A': '+918049001021',
  'ICU-1': '+918049001101',
  ED: '+918049001911',
}

function extensionFor(bed: string | null): string {
  if (!bed) return '+918049001000'
  const ward = bed.split('-').slice(0, bed.startsWith('ICU') ? 2 : 1).join('-')
  return WARD_EXTENSIONS[ward] ?? '+918049001000'
}

/**
 * Every delta the record holds for a patient, newest-relevant first. The caller
 * passes `since` — the moment this clinician last saw them — and anything older
 * is not a change.
 */
export function deltasFor(patientId: string, since: Date): Delta[] {
  const out: Delta[] = []

  for (const r of RESULTS) {
    if (r.patientId !== patientId || r.acknowledged) continue
    if (r.flag === 'Normal') continue
    out.push({
      type: r.critical ? 'lab-critical' : 'vitals',
      shortLabel: `${r.test.replace('Serum ', '')} ${r.flag.startsWith('↑') ? '↑' : '↓'}`,
      label: `${r.test} ${r.value} ${r.unit}`,
      icon: r.critical ? 'TriangleAlert' : 'FlaskConical',
      ts: r.reportedAt.toISOString(),
      value: `${r.value} ${r.unit}`,
      priority: DELTA_PRIORITY[r.critical ? 'lab-critical' : 'vitals'],
      detail: `${r.delta ?? 'no prior value'} · reference ${r.refRange}`,
      ai: 'AI-212',
    })
  }

  const vitals = VITALS[patientId] ?? []
  const abnormal = vitals.filter((v) => v.flag !== 'Normal')
  if (abnormal.length > 0) {
    const worst = abnormal[0]
    out.push({
      type: 'vitals',
      shortLabel: `${worst.label.split(' ')[0]} ${worst.flag.startsWith('↑') ? '↑' : '↓'}`,
      label: `${worst.label} ${worst.value}`,
      icon: 'HeartPulse',
      ts: worst.at.toISOString(),
      value: worst.value,
      priority: DELTA_PRIORITY.vitals,
      detail: `${abnormal.length} of ${vitals.length} observations outside range at ${formatTime(worst.at)}`,
    })
  }

  for (const e of timelineFor(patientId)) {
    if (e.kind === 'imaging') {
      out.push({
        type: 'imaging',
        shortLabel: 'Imaging ▲',
        label: e.label,
        icon: 'Image',
        ts: e.at.toISOString(),
        priority: DELTA_PRIORITY.imaging,
        detail: e.detail,
        ai: e.ai,
      })
    } else if (e.kind === 'medication') {
      out.push({
        type: 'med',
        shortLabel: 'Med +',
        label: e.label,
        icon: 'Pill',
        ts: e.at.toISOString(),
        priority: DELTA_PRIORITY.med,
        detail: e.detail,
      })
    } else if (e.kind === 'note') {
      out.push({
        type: 'note',
        shortLabel: 'Note',
        label: e.label,
        icon: 'FileText',
        ts: e.at.toISOString(),
        priority: DELTA_PRIORITY.note,
        detail: e.detail,
      })
    }
  }

  const chasing = ordersFor(patientId).filter((o) => o.chase)
  if (chasing.length > 0) {
    out.push({
      type: 'timer',
      shortLabel: 'Overdue',
      // Named for what it IS, not for the order — otherwise it reads as a
      // duplicate of the imaging event sitting next to it.
      label: `${chasing[0].category} order running late`,
      icon: 'Clock',
      ts: chasing[0].placedAt.toISOString(),
      priority: DELTA_PRIORITY.timer,
      detail: `${chasing[0].item} · ${chasing[0].chase}`,
      ai: 'AI-308',
    })
  }

  return out
    .filter((d) => new Date(d.ts) > since)
    .sort((a, b) => a.priority - b.priority || new Date(b.ts).getTime() - new Date(a.ts).getTime())
}

/** The last note on the record, with the author's initials. */
export function lastNoteFor(patientId: string): { label: string; detail: string; by: string; initials: string; at: Date } | undefined {
  const e = timelineFor(patientId).find((x) => x.kind === 'note' || x.kind === 'ai' || x.kind === 'result')
  if (!e) return undefined
  const initials = e.by
    .replace(/^(Dr\.?|Sr\.?|Mr|Ms)\s+/, '')
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 3)
    .toUpperCase()
  return { label: e.label, detail: e.detail, by: e.by, initials, at: e.at }
}

export function cardFor(patientId: string, lastSeen: Date, urgency: Urgency): MyDayCard {
  const p = patient(patientId)
  const row = INPATIENTS.find((r) => r.patientId === patientId)
  const clinic = CLINIC_LIST.find((c) => c.patientId === patientId)
  const bed = row?.bed ?? p.bed
  const category: MyDayCard['status_category'] =
    urgency === 'critical' ? 'critical' : urgency === 'warning' ? 'moderate' : 'normal'

  return {
    patient_id: patientId,
    name: `${p.name} (${p.sex}/${p.age})`,
    mrn: p.uhid,
    room: bed ?? 'outpatient',
    scheduled_time: (clinic?.bookedAt ?? row?.chronologicalAt ?? NOW).toISOString(),
    status_category: category,
    status_color_hex: STATUS_HEX[category],
    lastSeenByClinician: lastSeen.toISOString(),
    delta_summary: deltasFor(patientId, lastSeen),
    active_timers: [],
    quick_actions: {
      markSeen: `POST /api/patients/${patientId}/seen`,
      openChart: `/patient/${p.uhid}/record`,
      callNurse: `tel:${extensionFor(bed)}`,
    },
  }
}

/**
 * When this clinician last saw a patient. The store overrides it once they mark
 * someone seen; until then it is derived from the record — the last entry this
 * clinician authored, or the start of the shift.
 */
export function derivedLastSeen(patientId: string): Date {
  const mine = timelineFor(patientId).find((e) => e.by.startsWith('Dr. Ananya'))
  // No entry of their own on this record means they have not seen this patient
  // this admission, so the cut-off is the start of the shift.
  return mine?.at ?? SHIFT_START
}
