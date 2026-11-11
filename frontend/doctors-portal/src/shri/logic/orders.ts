// ported from src/screens/m09/S0901.tsx:56-70 (AI-304's duplicate check, at the
// moment of adding rather than at audit) and 100-102 (the suggestions, the LOW
// one folded).
//
// AI-301's four suggestions are drawn from R. Lakshmanan's record — the oxygen
// requirement that doubled overnight, the creatinine that rose 64 µmol/L. The
// old basket offered them on every patient's encounter; here they are offered
// on his, and a patient with no suggestion drawn from their own record gets
// none rather than someone else's.

import { ORDERS, ORDER_SUGGESTIONS, ordersFor } from '@/data/clinical'
import { NOW } from '@/data/format'
import { patient } from '@/data/kit'
import { useAudit } from '@/store/audit'
import { useClinical } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { useNotifications } from '../state/notifications'

/** The patient whose record AI-301's suggestions were drawn from. */
const SUGGESTED_FOR = 'SD-P-03'

export function suggestionsFor(patientId: string): (typeof ORDER_SUGGESTIONS)[number][] {
  return patientId === SUGGESTED_FOR ? ORDER_SUGGESTIONS : []
}

/** AI-304 — a repeat of something resulted inside 24 hours, with the reason in the rule's words. */
export function duplicateCheck(item: string, patientId: string): { id: string; placedAt: string; reason: string } | undefined {
  const prior = ordersFor(patientId).find((o) => o.item === item && o.status === 'Resulted')
  if (!prior) return undefined
  const hours = (NOW.getTime() - prior.placedAt.getTime()) / 3_600_000
  if (hours > 24) return undefined
  const flagged = ORDERS.find((o) => o.item === item && o.duplicateReason)
  return {
    id: prior.id,
    placedAt: prior.placedAt.toISOString(),
    reason: flagged?.duplicateReason ?? `${item} was resulted ${Math.round(hours)} hours ago. A repeat inside 24 hours rarely changes management on this trajectory.`,
  }
}

/** The void reasons S-09-03 offers, in its words. */
export const CANCEL_REASONS = ['No longer clinically indicated', 'Ordered in error', 'Duplicate of another order', 'Patient declined']

/**
 * One way to void an order, wherever it is done (S-09-03's Cancel, S-09-08's
 * accepted flag): voided, never deleted, the reason recorded against it, on
 * the audit trail, and sent to the performing department.
 */
export function useVoidOrder() {
  const me = useCurrentStaff()
  const cancelOrder = useClinical((s) => s.cancelOrder)
  const audit = useAudit((s) => s.record)
  const send = useNotifications((s) => s.send)
  const toast = useUI((s) => s.toast)
  return ({ orderId, item, patientId, reason, where, returnTo }: { orderId: string; item: string; patientId: string; reason: string; where: string; returnTo: string }) => {
    const p = patient(patientId)
    cancelOrder(orderId, reason)
    audit({ event: 'ORDER.CANCELLED', actor: me.name, actorId: me.id, subject: patientId, detail: `${item} · ${orderId} · ${reason} · ${where}` })
    // "The performing department is notified."
    send({ severity: 'routine', kind: 'order', title: `${item} voided`, detail: `${p.name} · ${orderId} · ${reason}`, to: returnTo, recipient: 'department' })
    toast({ tone: 'info', title: `${item} voided`, detail: `Reason recorded: ${reason}` })
  }
}
