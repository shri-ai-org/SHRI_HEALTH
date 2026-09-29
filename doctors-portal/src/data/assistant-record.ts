/**
 * The assistant reading the record — answers built at ask time from the data
 * the doctor's own screens already show, rather than from documentation.
 *
 * These are what a doctor actually asks the bubble: what changed, what the
 * latest reports say, what needs them today. Each is a RETRIEVAL, not an
 * interpretation: it lists what the record holds and cites every line back to
 * the entry it came from, so the grounded-or-silent rule still holds. Nothing
 * here concludes anything clinical — that stays with the capability that owns
 * it, under its own gate.
 *
 * Two guardrails apply here rather than in the corpus:
 *   Guardrail 4  Only the Z3 patient. A patient question needs a patient in
 *                context, and a sealed patient (no care relationship, no
 *                break-glass) answers nothing — the same rule the Quick-Panel
 *                follows.
 *   Guardrail 2  Every builder returns citations, or is not offered at all.
 */

import type { PersonaId } from '@/atlas/personas'

import type { AssistantAnswer, Citation } from './assistant'
import { PRIORITY_LABEL, TYPE_LABEL, stageLabel } from './admissions'
import type { Admissions } from './admissions'
import { RESULTS, resultsFor } from './clinical'
import { NOW, formatDate, formatDateTime, formatTime } from './format'
import { maybePatient } from './kit'
import type { Patient } from './kit'
import { attentionFor, deltasFor, derivedLastSeen } from './myday'
import type { AttentionItem } from './myday'
import { activeMedicines, conditionFor, prescriptionsFor, reportsFor } from './record'

/** The session state a record answer reads — what My Day reads, and no more. */
export interface LiveContext {
  persona: PersonaId
  acknowledgements: Record<string, unknown>
  /** Patient id → ISO time this doctor marked them seen. */
  seenAt: Record<string, string>
  admissions: Admissions
  /** Patients this doctor has broken the glass for. */
  breakGlass: Record<string, unknown>
  /** The doctor's latest action this session, if it was recent. */
  recent?: { event: string; subject?: string }
}

/** The default a caller without a session gets — the audit script, the full-page assistant. */
export const DEFAULT_LIVE: LiveContext = {
  persona: 'P-04',
  acknowledgements: {},
  seenAt: {},
  admissions: {},
  breakGlass: {},
}

/** The record answers, by the question that asks for each. */
export type RecordIntent = 'changes' | 'reports' | 'condition' | 'medicines' | 'admission' | 'attention'

/**
 * Specific on purpose. These run ahead of the corpus, so a broad token here
 * would shadow it — "summary" alone would catch "discharge summary", and
 * "attention" alone would catch "what puts a patient on needs-my-attention?".
 */
const INTENT_MATCH: [RecordIntent, string[]][] = [
  ['changes', ['changed since', 'what changed', 'recent changes', 'what is new', "what's new", 'new since']],
  ['reports', ['latest report', 'recent report', 'summarise the report', 'summarize the report', 'summarise', 'summarize', 'latest result']],
  ['condition', ['doing overall', 'current condition', 'how is the patient', 'how is this patient']],
  ['medicines', ['on right now', 'active medicines', 'current medicines', 'current medication', 'what medicines']],
  ['admission', ['admission up to', 'where is the admission', 'admission status']],
  ['attention', ['attention today', 'needs my attention today', 'waiting on me', 'needs me today']],
]

export function recordIntent(question: string): RecordIntent | undefined {
  const q = question.toLowerCase()
  return INTENT_MATCH.find(([, match]) => match.some((m) => q.includes(m)))?.[0]
}

/** The name a question uses — "Meera", but "R. Lakshmanan" rather than "R.". */
export function callName(p: Patient): string {
  const first = p.name.split(/\s+/)[0]
  return first.length <= 2 || first.endsWith('.') ? p.name : first
}

/** No care relationship and no break-glass: the record is sealed, here as on the Quick-Panel. */
export function isSealed(p: Patient, live: LiveContext): boolean {
  return p.consultant === undefined && !live.breakGlass[p.id]
}

function when(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return date.toDateString() === NOW.toDateString() ? formatTime(date) : formatDateTime(date)
}

function clip(text: string, max = 110): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function answer(body: string, citations: Citation[]): AssistantAnswer {
  return { kind: 'cited', body, citations, band: 'HIGH' }
}

/** Numbers citations as they are added, so the body and the list agree. */
function citer() {
  const list: Citation[] = []
  return {
    list,
    add(c: Omit<Citation, 'n'>): string {
      const n = list.length + 1
      list.push({ ...c, n })
      return `[${n}]`
    },
  }
}

// ─────────────────────────────────────────────────────── The builders

function lastSeenFor(p: Patient, live: LiveContext): Date {
  const seen = live.seenAt[p.id]
  return seen ? new Date(seen) : derivedLastSeen(p.id)
}

function changes(p: Patient, live: LiveContext): AssistantAnswer | undefined {
  const since = lastSeenFor(p, live)
  const deltas = deltasFor(p.id, since)
  const c = citer()

  if (deltas.length === 0) {
    const ref = c.add({ label: 'The whole record, in time order', source: 'S-06-06 · Timeline', to: `/patient/${p.uhid}/timeline` })
    return answer(`Nothing new on the record since you last saw ${callName(p)} at ${when(since)}. ${ref}`, c.list)
  }

  const shown = deltas.slice(0, 5)
  const lines = shown.map((d) => {
    const result = RESULTS.find((r) => r.patientId === p.id && d.label.startsWith(r.test))
    const ref = result
      ? c.add({ label: d.label, source: `Result ${result.id}`, to: `/results/${result.id}` })
      : c.add({ label: d.label, source: `Timeline · ${when(d.ts)}`, to: `/patient/${p.uhid}/timeline` })
    return `• **${d.label}**${d.detail ? ` — ${clip(d.detail)}` : ''} ${ref}`
  })
  const more = deltas.length - shown.length
  const count = deltas.length === 1 ? '1 change' : `${deltas.length} changes`

  return answer(
    [
      `**${count}** since you last saw ${callName(p)} at ${when(since)}, most urgent first:`,
      lines.join('\n'),
      more > 0 ? `${more} more on the timeline.` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    c.list,
  )
}

function reports(p: Patient): AssistantAnswer | undefined {
  const docs = reportsFor(p.id).slice(0, 3)
  const abnormal = resultsFor(p.id)
    .filter((r) => r.flag !== 'Normal')
    .slice(0, 3)
  if (docs.length === 0 && abnormal.length === 0) return undefined

  const c = citer()
  const parts: string[] = []

  if (docs.length > 0) {
    const lines = docs.map((r) => {
      const to = r.studyId && r.viewable ? `/radiology/study/${r.studyId}/view` : `/patient/${p.uhid}/reports`
      const ref = c.add({ label: r.title, source: `${r.kind} · ${r.id}`, to })
      return `• **${r.title}**, ${formatDate(r.at)} — ${clip(r.summary)} ${ref}`
    })
    parts.push(`**Latest reports**\n${lines.join('\n')}`)
  }

  if (abnormal.length > 0) {
    const lines = abnormal.map((r) => {
      const ref = c.add({ label: `${r.test} ${r.value} ${r.unit}`, source: `Result ${r.id}`, to: `/results/${r.id}` })
      return `• **${r.test} ${r.value} ${r.unit}** (${r.flag}), ${when(r.reportedAt)}${r.acknowledged ? '' : ' — not yet acknowledged'} ${ref}`
    })
    parts.push(`**Results outside range**\n${lines.join('\n')}`)
  }

  return answer(parts.join('\n\n'), c.list)
}

function condition(p: Patient): AssistantAnswer | undefined {
  const s = conditionFor(p.id)
  if (!s) return undefined
  const c = citer()
  const ref = c.add({
    label: `Current condition, updated ${when(s.updatedAt)} by ${s.updatedBy}`,
    source: 'S-06-15 · Current condition',
    to: `/patient/${p.uhid}/condition`,
  })
  const watch = s.watch.map((w) => `• ${w}`).join('\n')
  return answer(
    [`**${s.status}** — ${s.headline}. ${ref}`, s.summary, watch && `**Keep an eye on**\n${watch}`].filter(Boolean).join('\n\n'),
    c.list,
  )
}

function medicines(p: Patient): AssistantAnswer | undefined {
  const active = activeMedicines(p.id)
  if (active.length === 0) return undefined
  const c = citer()
  const refs = new Map<string, string>()
  for (const r of prescriptionsFor(p.id)) {
    if (!r.items.some((i) => i.status === 'Active')) continue
    refs.set(
      `${r.at.getTime()}|${r.by}`,
      c.add({ label: `${r.context}, ${formatDate(r.at)} — ${r.by}`, source: `Prescription ${r.id}`, to: `/patient/${p.uhid}/prescriptions` }),
    )
  }
  const lines = active.map(
    (m) => `• **${m.drug} ${m.dose}** ${m.route} ${m.frequency}${m.note ? ` — ${clip(m.note, 70)}` : ''} ${refs.get(`${m.since.getTime()}|${m.by}`) ?? ''}`,
  )
  const allergyRef = c.add({ label: 'Allergies on the record', source: 'Patient banner', to: `/patient/${p.uhid}/record` })
  const allergies = p.allergies.length > 0 ? `**Allergies:** ${p.allergies.join(', ')} ${allergyRef}` : `No allergies recorded. ${allergyRef}`
  const count = active.length === 1 ? '1 active medicine' : `${active.length} active medicines`
  return answer([`**${count}** for ${callName(p)}:`, lines.join('\n'), allergies].join('\n\n'), c.list)
}

function admission(p: Patient, live: LiveContext): AssistantAnswer | undefined {
  const a = live.admissions[p.id]
  if (!a) return undefined
  const c = citer()
  const ref = c.add({ label: `${TYPE_LABEL[a.type]} admission, ${PRIORITY_LABEL[a.priority]}`, source: `Admission ${a.id}`, to: `/patient/${p.uhid}/record` })
  const stage = stageLabel(a)
  return answer(
    [
      `${TYPE_LABEL[a.type]} admission, ${PRIORITY_LABEL[a.priority].toLowerCase()} — **${stage}**. ${ref}`,
      `Requested by ${a.requestedBy} at ${formatTime(new Date(a.requestedAt))}. ${a.admittedAt !== undefined ? `${callName(p)} is now on the Inpatients list.` : 'The front office allocates the bed and completes the admission; nothing more is needed from you.'}`,
    ].join('\n\n'),
    c.list,
  )
}

/** Where an attention item's evidence lives. */
function attentionSource(item: AttentionItem, p: Patient): Omit<Citation, 'n'> {
  const label = `${p.name} · ${item.reason}`
  if (item.id.startsWith('result-')) {
    const id = item.id.slice('result-'.length)
    return { label, source: `Result ${id}`, to: `/results/${id}` }
  }
  if (item.id.startsWith('cosign-')) return { label, source: 'S-06-09 · Co-sign queue', to: '/clinician/cosign' }
  if (item.id.startsWith('stroke-')) {
    return { label, source: `Stroke case ${item.id.slice('stroke-'.length)}`, to: `/stroke/case/${item.id.slice('stroke-'.length)}/clock` }
  }
  return { label, source: item.ai ?? 'S-06-01 · My Day', to: `/patient/${p.uhid}/record` }
}

function attention(live: LiveContext): AssistantAnswer {
  const items = attentionFor(live.persona, live.acknowledgements, live.admissions).filter((i) => !live.seenAt[i.patientId])
  const c = citer()

  if (items.length === 0) {
    const ref = c.add({ label: 'Needs Action · Attention', source: 'S-06-01 · My Day', to: '/clinician' })
    return answer(
      `Nothing is waiting on you right now — no unacknowledged critical result, no new deterioration and nothing to co-sign. ${ref}`,
      c.list,
    )
  }

  const lines = items.map((i) => {
    const p = maybePatient(i.patientId)
    if (!p) return ''
    const ref = c.add(attentionSource(i, p))
    // A sealed patient's detail stays behind break-glass, as on the Quick-Panel.
    const detail = isSealed(p, live) ? '' : ` — ${clip(i.detail, 90)}`
    return `• **${p.name}** · ${i.reason}${detail} ${ref}`
  })
  const count = items.length === 1 ? '1 patient needs you' : `${items.length} patients need you`

  return answer([`**${count}**, most urgent first:`, lines.filter(Boolean).join('\n')].join('\n\n'), c.list)
}

// ─────────────────────────────────────────────────────── The entry points

/**
 * Answer a record question, or return undefined so the corpus gets its turn.
 * A patient question without a patient in context is not a record question.
 */
export function recordAnswer(
  intent: RecordIntent,
  patientId: string | undefined,
  live: LiveContext,
): AssistantAnswer | undefined {
  if (intent === 'attention') return attention(live)

  // Asked from My Day just after admitting someone, the admission is the subject.
  const p = maybePatient(patientId ?? (intent === 'admission' ? live.recent?.subject : undefined))
  if (!p || isSealed(p, live)) return undefined

  switch (intent) {
    case 'changes':
      return changes(p, live)
    case 'reports':
      return reports(p)
    case 'condition':
      return condition(p)
    case 'medicines':
      return medicines(p)
    case 'admission':
      return admission(p, live)
  }
}

/**
 * The patient questions worth offering — only those the record can answer.
 * Order is the order a doctor asks them in: what is new, then what was found.
 */
export function patientPrompts(patientId: string, live: LiveContext): { intent: RecordIntent; text: string }[] {
  const p = maybePatient(patientId)
  if (!p || isSealed(p, live)) return []
  const name = callName(p)
  const out: { intent: RecordIntent; text: string }[] = []

  if (deltasFor(p.id, lastSeenFor(p, live)).length > 0) out.push({ intent: 'changes', text: `What changed since I last saw ${name}?` })
  if (reports(p)) out.push({ intent: 'reports', text: 'Summarise the latest reports' })
  if (conditionFor(p.id)) out.push({ intent: 'condition', text: `How is ${name} doing overall?` })
  if (activeMedicines(p.id).length > 0) out.push({ intent: 'medicines', text: `What is ${name} on right now?` })
  return out
}

/** The one prompt a recent action earns, if the answer is about this context. */
export function admissionPrompt(patientId: string | undefined, live: LiveContext): string | undefined {
  const p = maybePatient(patientId)
  if (!p || !live.admissions[p.id]) return undefined
  return `Where is ${callName(p)}’s admission up to?`
}

export const ATTENTION_PROMPT = 'What needs my attention today?'
