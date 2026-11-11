/**
 * S-06-06 · the record's timeline — the entries written for it (`TIMELINE` in
 * `clinical.ts`), and everything else already on the record, read from where
 * it is kept: the admission, results and cultures, imaging, notes, documents,
 * prescriptions and the vitals charted. Nothing here is new data — it is the
 * record, in time order — so the timeline can never disagree with the tab a
 * result or a note lives on.
 *
 * An entry written for the timeline wins over the one read from the record at
 * the same moment: the same kind within ten minutes is one event, not two.
 *
 * My Day's "since you last saw them" reads `timelineFor` (the written entries)
 * on purpose — its counts are about what a clinician wrote down, and they stay
 * as they were.
 */

import { ENCOUNTERS, RESULTS, VITALS, timelineFor, type TimelineEvent } from './clinical'
import { imagingFor } from './imaging'
import { staff } from './kit'
import { PAST_NOTES, PRESCRIPTION_HISTORY, reportsFor } from './record'
import { microFor } from './results-ext'

const WINDOW_MS = 10 * 60_000

const ENCOUNTER_WORD = { OP: 'Outpatient visit', IP: 'Admitted', ED: 'Arrived in Emergency', TELE: 'Teleconsult' } as const

/** What the record already holds, as timeline entries. */
function fromRecord(patientId: string): TimelineEvent[] {
  const out: TimelineEvent[] = []

  for (const e of ENCOUNTERS.filter((x) => x.patientId === patientId)) {
    const who = (() => {
      try {
        return staff(e.consultantStaffId).name
      } catch {
        return 'Registration'
      }
    })()
    out.push({
      at: e.startedAt,
      kind: 'admission',
      label: `${ENCOUNTER_WORD[e.type]}${e.ward ? ` — ${e.ward}` : ''}`,
      detail: `${e.encounterNo} · ${e.department}${e.token ? ` · token ${e.token}` : ''}`,
      by: who,
    })
  }

  for (const r of RESULTS.filter((x) => x.patientId === patientId)) {
    out.push({
      at: r.reportedAt,
      kind: 'result',
      label: `${r.test} ${r.value}${r.unit ? ` ${r.unit}` : ''}`,
      detail: `${r.flag === 'Normal' ? 'Within range' : r.flag.replace(/^[↑↓]+\s*/, '')} · range ${r.refRange}${r.unit ? ` ${r.unit}` : ''}`,
      by: 'Laboratory',
    })
  }

  for (const m of microFor(patientId)) {
    out.push({
      at: m.reportedAt,
      kind: 'result',
      label: m.test,
      detail: `${m.growth}${m.count ? ` · ${m.count}` : ''} · ${m.status.toLowerCase()}`,
      by: 'Microbiology',
    })
  }

  for (const s of imagingFor(patientId)) {
    out.push({ at: s.acquiredAt, kind: 'imaging', label: s.description, detail: s.impression, by: s.reportedBy ?? 'Awaiting radiologist' })
  }

  for (const d of reportsFor(patientId).filter((r) => r.kind !== 'Imaging')) {
    out.push({ at: d.at, kind: 'note', label: d.title, detail: d.summary, by: d.by })
  }

  for (const n of PAST_NOTES.filter((x) => x.patientId === patientId)) {
    out.push({ at: n.at, kind: 'note', label: `${n.kind} — ${n.setting}`, detail: n.assessment, by: n.by })
  }

  for (const rx of PRESCRIPTION_HISTORY.filter((x) => x.patientId === patientId)) {
    out.push({
      at: rx.at,
      kind: 'medication',
      label: `Prescription — ${rx.context}`,
      detail: rx.items.map((i) => `${i.drug} ${i.dose}`).join(' · '),
      by: rx.by,
    })
  }

  const vitals = VITALS[patientId] ?? []
  if (vitals.length > 0) {
    const outside = vitals.filter((v) => v.flag !== 'Normal')
    out.push({
      at: vitals[0].at,
      kind: 'vitals',
      label: 'Vitals charted',
      detail: outside.length > 0 ? `${outside.map((v) => `${v.label} ${v.value}`).join(' · ')} outside range` : `${vitals.length} observations, all within range`,
      by: 'Nursing',
    })
  }

  return out
}

/** The whole record in time order, newest first: the written entries, and the record's own where none was written. */
export function recordTimelineFor(patientId: string): TimelineEvent[] {
  const written = timelineFor(patientId)
  const read = fromRecord(patientId).filter((e) => !written.some((w) => w.kind === e.kind && Math.abs(w.at.getTime() - e.at.getTime()) <= WINDOW_MS))
  return [...written, ...read].sort((a, b) => b.at.getTime() - a.at.getTime())
}
