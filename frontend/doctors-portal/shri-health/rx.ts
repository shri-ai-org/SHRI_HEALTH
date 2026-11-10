// SHRI_HEALTH data layer: the prescription screen's basket (src/shri/logic/rx.ts) with the server's
// safety check (D99) in place of the browser's own rule. The screen's basket logic is reused as it
// is; only each line's hard stop, and its override, come from the prescription's latest check.
import type { HardStop } from '@/data/clinical'
import type { RxOverride, RxRecord } from '@/store/clinical'

import { basketFor as screenBasketFor, type BasketLine as ScreenBasketLine } from '../src/shri/logic/rx'
import type { SafetyAlert } from '../../src/api/generated/model'

import { useClinical, type RxLineEdit } from './clinical'

export { DURATIONS, ROUTE_FREQUENCIES, newLine, proposedBasket } from '../src/shri/logic/rx'

/** The screen's line, with the contract's quantity, unit and refills (SCREEN_PORT.md). */
export type BasketLine = ScreenBasketLine & { quantity: string; quantityUnit: string; refills: number }

/** Signing needs a quantity (value and unit); like the screen's other gaps, it holds Sign back. */
const QUANTITY_GAP = 'Quantity and its unit are not stated yet.'

const RULE: Record<string, string> = {
  allergy: 'Allergy — fixed rule (D99)',
  'duplicate-medication': 'Duplicate medication — fixed rule (D99)',
}

/** A high alert as the screen's hard stop. TODO(gap): warning and info alerts have no place on the screen. */
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
      stop,
      // This screen's own record names both clinicians; the server's names only the user's ID (gap 18).
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
