// ported from src/screens/m15/S1504.tsx:53, 175-187 — the model a head CT that
// is not a stroke case is read by, and which finding needs a person told.

import type { Citation } from '@/data/assistant'
import { maybeScreen } from '@/atlas/registry'
import { IMAGING_TRIAGE, type StrokeCase } from '@/data/stroke'
import type { AiFinding } from '@/data/strokeai'

/** A read the AI makes on any head CT that is not a stroke case — the haemorrhage and mass-effect classifiers. */
export const NCCT_MODEL = 'ncct-ich v3.1.0'

/** The one to escalate first: blood, then shift, then mass effect, then anything else flagged; on a clean scan, the occlusion the triage found. */
export function criticalFindingFor(findings: AiFinding[], c: StrokeCase | undefined): { label: string; value: string } | undefined {
  const ORDER = ['Intracranial haemorrhage', 'Midline shift', 'Mass effect']
  const bleed = ORDER.map((label) => findings.find((f) => f.critical && f.label === label)).find(Boolean) ?? findings.find((f) => f.critical)
  if (bleed) return { label: bleed.label, value: bleed.value }
  const lvo = IMAGING_TRIAGE.findings.find((f) => f.label === 'LVO')
  return c?.imaging.lvo && lvo ? { label: 'Large vessel occlusion', value: lvo.value } : undefined
}

/**
 * Where a citation opens: its own route where it names a record entry, else
 * the screen its source names — but only a screen with no id in its address.
 * The old `routeForSource` filled an id in with a fixed patient's, so a
 * citation could open someone else's record; here it opens nothing instead.
 */
export function citationLink(c: Citation): string | undefined {
  if (c.to) return c.to
  const m = /S-\d\d-\d\d/.exec(c.source)
  const route = m ? maybeScreen(m[0])?.route : undefined
  return route && !route.includes(':') ? route : undefined
}
