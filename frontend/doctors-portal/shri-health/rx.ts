// SHRI_HEALTH data layer: the prescription screen's basket (src/shri/logic/rx.ts) with the server's
// safety check (D99) in place of the browser's own rule. The screen's basket logic is reused as it
// is; only each line's hard stop, its override and its notes come from the prescription's latest
// check. A `high` alert that needs an override is the hard stop (the prescriber's reason, D97). A
// `warning` or `info` alert (a duplicate medication, say) is a note on the line: shown clearly,
// never blocking Sign (Vimal, 13 Nov).
import type { HardStop } from '@/data/clinical'
import type { RxOverride, RxRecord } from '@/store/clinical'

import { basketFor as screenBasketFor, type BasketLine as ScreenBasketLine } from '../src/shri/logic/rx'
import type { SafetyAlert } from '../../src/api/generated/model'

import { useClinical, type RxLineEdit } from './clinical'

export { DURATIONS, ROUTE_FREQUENCIES, newLine, proposedBasket } from '../src/shri/logic/rx'

/** A warning or info alert from the server's check, shown on its line; it never blocks Sign. */
export interface LineNote {
  id: string
  severity: 'warning' | 'info'
  title: string
  message: string
}

/** The screen's line, with the contract's quantity, unit and refills (SCREEN_PORT.md), and its notes. */
export type BasketLine = ScreenBasketLine & { quantity: string; quantityUnit: string; refills: number; notes: LineNote[] }

/** Signing needs a quantity (value and unit); like the screen's other gaps, it holds Sign back. */
const QUANTITY_GAP = 'Quantity and its unit are not stated yet.'

/** The alert's kind in words (D99's fixed rules; `interaction` waits for Q13). */
const KIND: Record<string, string> = {
  allergy: 'Allergy',
  'duplicate-medication': 'Duplicate medication',
  interaction: 'Drug interaction',
}

const RULE: Record<string, string> = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [k, `${v} — fixed rule`]))

/** A high alert as the screen's hard stop. */
function toHardStop(alert: SafetyAlert, checkedAt?: string): HardStop {
  return {
    rule: RULE[alert.kind] ?? alert.kind,
    finding: alert.message,
    severity: 'contraindicated',
    deterministic: true,
    documentedAt: checkedAt ?? '',
    documentedBy: '',
    // The server proposes no alternatives.
    alternatives: [],
    auditEvent: `RX.ALERT.${alert.kind.toUpperCase()}`,
  }
}

/** The line's warning and info alerts from its latest check, as notes. */
function serverNotes(lineId: string): LineNote[] {
  const alerts = useClinical.getState().rxServer[lineId]?.alerts ?? []
  return alerts
    .filter((a) => !a.overrideRequired && (a.severity === 'warning' || a.severity === 'info'))
    .map((a) => ({ id: a.id, severity: a.severity as LineNote['severity'], title: KIND[a.kind] ?? a.kind, message: a.message }))
}

function serverStop(lineId: string): { stop?: HardStop; override?: RxOverride } {
  const server = useClinical.getState().rxServer[lineId]
  const high = server?.alerts.filter((a) => a.overrideRequired) ?? []
  if (high.length === 0) return {}
  const stop = toHardStop(high[0], server?.checkedAt)
  const done = high.every((a) => a.override)
  const o = high[0].override
  return { stop, override: done && o ? { lineId, reason: o.reason, prescriber: '', coSigner: '', at: o.overriddenAt, auditEvent: stop.auditEvent } : undefined }
}

/** The basket as the screen draws it, with each line's stop from the server's latest check. */
export function basketFor(proposed: Parameters<typeof screenBasketFor>[0], rec: RxRecord, allergies: string[]): BasketLine[] {
  return screenBasketFor(proposed, rec, allergies).map((line) => {
    const { stop, override } = serverStop(line.id)
    const local = (rec.overrides ?? []).find((o) => o.lineId === line.id)
    const edit: RxLineEdit = rec.edits?.[line.id] ?? {}
    const quantity = edit.quantity ?? ''
    const quantityUnit = edit.quantityUnit ?? ''
    const stated = Number(quantity) > 0 && quantityUnit.trim() !== ''
    return {
      ...line,
      quantity,
      quantityUnit,
      refills: edit.refills ?? 0,
      gaps: stated ? line.gaps : [...line.gaps, QUANTITY_GAP],
      notes: serverNotes(line.id),
      stop,
      // The override this screen recorded (the prescriber's reason), else the server's (gap 18).
      override: stop ? (local ?? override) : undefined,
    }
  })
}

/** Whether a drug is blocked: known only once the server has checked its prescription. */
export function hardStopFor(drug: string, _allergies: string[]): HardStop | undefined {
  for (const rec of Object.values(useClinical.getState().prescriptions)) {
    for (const line of rec.added ?? []) {
      if (line.drug === drug) {
        const { stop } = serverStop(line.id)
        if (stop) return stop
      }
    }
  }
  return undefined
}
