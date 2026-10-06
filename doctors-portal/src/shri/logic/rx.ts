// ported from src/screens/m06/S0607.tsx:65-70 (`hardStopFor`), 82 (the proposed
// basket), 97-127 (the live basket and the sign gate), 133-149 (a line added from
// the formulary) and 403-424 (the alternative that replaces a blocked line).
//
// The hard stop is a rule, not a model: the documented allergy and the drug's
// class, recomputed on every render and never cached from the seed. What the old
// screen held in component state — added lines, and every change made to a line —
// lives on the prescription (`useClinical`), so what is signed is what was shown.

import { FORMULARY, PENICILLIN_HARD_STOP, RX_BASKET_SD_P_01, RX_BASKET_SD_P_03, type HardStop, type RxLine } from '@/data/clinical'
import type { IcdCode } from '@/data/icd10'
import type { RxOverride, RxRecord } from '@/store/clinical'

/**
 * The deterministic rule. It reads the documented allergy and the drug's class
 * from the formulary — nothing else. No model, no threshold, no confidence.
 */
export function hardStopFor(drug: string, allergies: string[]): HardStop | undefined {
  const entry = FORMULARY.find((f) => f.drug === drug)
  if (!entry?.betaLactam) return undefined
  if (!allergies.includes('Penicillin')) return undefined
  return PENICILLIN_HARD_STOP
}

/**
 * The proposed basket. The old screen handed every patient but SD-P-03 the
 * levothyroxine written for SD-P-01; a patient with nothing proposed starts with
 * an empty prescription rather than somebody else's.
 */
export function proposedBasket(patientId: string): RxLine[] {
  if (patientId === 'SD-P-03') return RX_BASKET_SD_P_03
  if (patientId === 'SD-P-01') return RX_BASKET_SD_P_01
  return []
}

/** The durations a line offers, in days. */
export const DURATIONS = [3, 5, 7, 14, 180]

/** The routes and frequencies a line offers after its own. */
export const ROUTE_FREQUENCIES = ['IV · 12-hourly', 'Oral · once daily']

/** A line added from the formulary states nothing yet: the old screen's placeholders, and no duration. */
export function newLine(drug: string): Omit<RxLine, 'id'> {
  const entry = FORMULARY.find((f) => f.drug === drug)
  return {
    drug,
    dose: '—',
    route: drug.includes('IV') ? 'IV' : 'Oral',
    frequency: 'as prescribed',
    durationDays: 0,
    substitutionAllowed: entry?.nlem ?? true,
  }
}

/** AI-305's static finding on a PRN line with no ceiling — the seeded line's words. */
export const PRN_CEILING_GAP = 'No maximum daily dose stated. Add a 24-hour ceiling (CMP-NABH-05).'

export interface BasketLine extends Omit<RxLine, 'hardStop' | 'completenessGap'> {
  /** Added from the formulary on this screen. */
  added: boolean
  /** "Route · frequency", as chosen. */
  routeFrequency: string
  /** The line's own route and frequency — the first option its select offers. */
  proposedRouteFrequency: string
  /** Taken as required, so it needs a stated 24-hour maximum. */
  prn: boolean
  maxDaily: string
  /** What is still missing, in the words shown on the line. Empty ⇒ complete. */
  gaps: string[]
  /** The hard stop the rule raises for this drug and this patient. */
  stop?: HardStop
  /** The dual-signature override signed for this line. It clears this line and no other. */
  override?: RxOverride
  /** The indication as an ICD-10 code, where there is one: chosen on this screen, or read from the proposed text. */
  indicationCode?: IcdCode
}

/** "Community-acquired pneumonia (J18.9)" → { code: 'J18.9', label: 'Community-acquired pneumonia' }; uncoded text → undefined. */
export function codedIndication(text?: string): IcdCode | undefined {
  const m = text?.match(/^(.*?)\s*\(([A-Z]\d{2}(?:\.[0-9A-Z]{1,4})?)\)\s*$/)
  return m ? { code: m[2], label: m[1].trim() } : undefined
}

/** "dose, frequency and duration" → "Dose, frequency and duration are not stated yet." */
function notStated(missing: string[]): string {
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`
  return `${list[0].toUpperCase()}${list.slice(1)} ${missing.length === 1 ? 'is' : 'are'} not stated yet.`
}

/** The alternative accepted in place of a blocked drug, carried onto its line. */
function substituted(line: RxLine, drug: string | undefined, added: boolean): RxLine {
  if (!drug) return line
  const alt = PENICILLIN_HARD_STOP.alternatives.find((a) => a.drug === drug)
  return {
    ...line,
    drug: alt ? `${alt.drug} ${alt.dose} ${alt.route}` : drug,
    dose: alt?.dose ?? line.dose,
    route: alt?.route ?? line.route,
    frequency: alt?.frequency ?? line.frequency,
    // A renal adjustment was proposed for the drug that is gone.
    doseAdjustment: undefined,
    hardStop: undefined,
    // The old screen's replacement for a line added here: a week, substitutable, the encounter's indication.
    ...(added ? { durationDays: 7, substitutionAllowed: true, indication: line.indication ?? 'Community-acquired pneumonia (J18.9)' } : {}),
  }
}

/** The prescription as it stands: proposed lines, minus removals, plus additions, with every change applied. */
export function basketFor(proposed: RxLine[], rec: RxRecord, allergies: string[]): BasketLine[] {
  const edits = rec.edits ?? {}
  const overrides = rec.overrides ?? (rec.override ? [rec.override] : [])
  const lines = [...proposed.map((l) => ({ l, added: false })), ...(rec.added ?? []).map((l) => ({ l, added: true }))].filter(
    ({ l }) => !rec.removedLines.includes(l.id),
  )

  return lines.map(({ l, added }) => {
    const base = substituted(l, rec.substitutions[l.id], added)
    const e = edits[l.id] ?? {}
    const dose = e.dose ?? base.dose
    const proposedRouteFrequency = `${base.route} · ${base.frequency}`
    const routeFrequency = e.routeFrequency ?? proposedRouteFrequency
    const [route, ...rest] = routeFrequency.split(' · ')
    const frequency = rest.join(' · ')
    const durationDays = e.durationDays ?? base.durationDays
    const prn = /as required/i.test(frequency)
    const maxDaily = e.maxDaily ?? ''

    const missing: string[] = []
    if (dose.trim() === '' || dose.trim() === '—') missing.push('dose')
    if (frequency.trim() === '' || frequency === 'as prescribed') missing.push('frequency')
    if (!(durationDays > 0)) missing.push('duration')

    const gaps: string[] = []
    if (missing.length > 0) gaps.push(notStated(missing))
    if (l.completenessGap === PRN_CEILING_GAP || (prn && !l.completenessGap)) {
      // The ceiling finding holds while the line is taken as required without a stated maximum.
      if (prn && maxDaily.trim() === '') gaps.push(l.completenessGap ?? PRN_CEILING_GAP)
    } else if (l.completenessGap) {
      // Any other seeded finding stands until the line is removed, as it did on the old screen.
      gaps.push(l.completenessGap)
    }

    const stop = hardStopFor(base.drug, allergies)
    // A choice made here wins; null is a cleared one. Otherwise the proposed text, read for its code.
    const indicationCode = e.indication !== undefined ? (e.indication ?? undefined) : codedIndication(base.indication)
    const indication = e.indication !== undefined ? (e.indication ? `${e.indication.label} (${e.indication.code})` : undefined) : base.indication
    return {
      ...base,
      indication,
      indicationCode,
      dose,
      route,
      frequency,
      durationDays,
      substitutionAllowed: e.substitutionAllowed ?? base.substitutionAllowed,
      instructions: e.instructions ?? base.instructions ?? '',
      added,
      routeFrequency,
      proposedRouteFrequency,
      prn,
      maxDaily,
      gaps,
      stop,
      override: stop ? overrides.find((o) => o.lineId === l.id) : undefined,
    }
  })
}
