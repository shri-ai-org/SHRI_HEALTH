// ported from src/screens/m18/S1806.tsx:77-90, 290-297, 345-352 and
// S1807.tsx:103-106 — the case's clinical acts, one place each: stamping an
// event, capturing a breach reason, moving a task on the board.
//
// The old screens called the stroke store and toasted, and wrote no record.
// Each act here also writes its audit row (decision 7) at case time — the
// server-derived clock, never the browser's (DD-012) — queued while the device
// is offline. A stamp taken offline is marked pending, as the old offline note
// promised ("Each stamp is marked pending until it reaches the server") and
// the old store never did; back online, the pending stamps and queued rows are
// written.

import { useEffect } from 'react'

import { formatTime } from '@/data/format'
import { ACTIVE_CASE } from '@/data/stroke'
import { useAudit } from '@/store/audit'
import { useCurrentStaff } from '@/store/session'
import { useStroke } from '@/store/stroke'
import { useUI } from '@/store/ui'

import { useForcedState } from '../state/ai'

import { useCaseNow } from './caseClock'

export function useStrokeActions() {
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const caseNow = useCaseNow()
  const offline = useForcedState() === 'OFFLINE'
  const subject = ACTIVE_CASE.patientId

  // Back online: the stamps held locally reach the server, and so do their audit rows.
  useEffect(() => {
    if (offline || !useStroke.getState().stamps.some((s) => s.pending)) return
    useStroke.setState((s) => ({ stamps: s.stamps.map((x) => (x.pending ? { ...x, pending: false } : x)) }))
    useAudit.getState().flushQueued()
  }, [offline])

  const row = (event: 'STROKE.EVENT_STAMPED' | 'STROKE.BREACH_REASON_CAPTURED' | 'STROKE.TASK_MOVED', detail: string) =>
    audit({ event, actor: me.name, actorId: me.id, subject, at: caseNow.toISOString(), detail, ...(offline ? { queued: true } : {}) })

  return {
    /** Append-only: an event already stamped is not stamped again, and says nothing. */
    stamp(key: string, label: string) {
      const store = useStroke.getState()
      if (store.isStamped(key)) return false
      store.stamp(key, label, me.name)
      if (offline) useStroke.setState((s) => ({ stamps: s.stamps.map((x) => (x.key === key ? { ...x, pending: true } : x)) }))
      row('STROKE.EVENT_STAMPED', `${ACTIVE_CASE.caseNo} · ${label} stamped ${formatTime(caseNow)} · append-only`)
      toast({ tone: 'success', title: `${label} stamped`, detail: `${formatTime(caseNow)} · by ${me.name} · append-only` })
      return true
    },
    captureBreach(intervalKey: string, intervalLabel: string, reason: string, detail?: string) {
      useStroke.getState().captureBreach({ intervalKey, reason, detail, by: me.name })
      row('STROKE.BREACH_REASON_CAPTURED', `${ACTIVE_CASE.caseNo} · ${intervalLabel} · ${reason}${detail ? ` — “${detail}”` : ''} · captured at ${formatTime(caseNow)}`)
      toast({ tone: 'info', title: 'Breach reason recorded', detail: `${reason} · ${formatTime(caseNow)}` })
    },
    moveTask(id: string, label: string, owner: string, column: string) {
      useStroke.getState().moveTask(id, column)
      row('STROKE.TASK_MOVED', `${ACTIVE_CASE.caseNo} · ${label} → ${column} · owner ${owner}`)
      toast({ tone: 'info', title: `${label} → ${column}`, detail: `owner ${owner}` })
    },
  }
}
