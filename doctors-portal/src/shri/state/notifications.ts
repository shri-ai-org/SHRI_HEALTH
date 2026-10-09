/**
 * The one notification system. The old build had none to reuse — its bell was
 * three fixed items in the app bar (`src/shell/AppBar.tsx:147-208`) — so this
 * starts from exactly those three, under the same three groups, each opening
 * its source screen. What this build sends on the doctor's behalf (to a
 * patient, to the front office) is recorded here as well, as sent items, so
 * there is never a second place a notification can live.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Severity = 'critical' | 'urgent' | 'routine'

/** Which glyph an item wears — the old bell's three, plus what this build sends. */
export type NoticeKind = 'result' | 'stroke' | 'cosign' | 'schedule' | 'appointment' | 'discharge' | 'instructions' | 'order' | 'video'

export interface Notice {
  id: string
  severity: Severity
  kind: NoticeKind
  title: string
  detail: string
  /** The screen it opens. */
  to: string
  /** Received by the doctor, or sent on their behalf. */
  direction: 'in' | 'out'
  /** Who a sent item went to. */
  recipient?: 'patient' | 'front office' | 'author' | 'colleague' | 'department'
  at?: string
}

/**
 * The old bell's items, word for word — less "DIDO projected breach" on the
 * stroke item, which is an AI-209 forecast and this build shows no forecasts.
 */
export const INBOX: Notice[] = [
  {
    id: 'N-01',
    severity: 'critical',
    kind: 'result',
    direction: 'in',
    title: 'Critical potassium 6.8 mmol/L',
    detail: 'J. Mathew · ICU-1 · unacknowledged 12 min',
    to: '/results/inbox',
  },
  {
    id: 'N-02',
    severity: 'urgent',
    kind: 'stroke',
    direction: 'in',
    title: 'Code stroke active at Pollachi',
    detail: 'STROKE/26-27/0141 · IPL',
    to: '/stroke/wall',
  },
  {
    id: 'N-03',
    severity: 'routine',
    kind: 'cosign',
    direction: 'in',
    title: 'Co-signatures pending',
    detail: '2 entries from your registrar',
    to: '/clinician/cosign',
  },
]

/** The group headings, in the old bell's order and words. */
export const SEVERITY_GROUP: Record<Severity, string> = {
  critical: 'Critical — interrupts and escalates',
  urgent: 'Urgent',
  routine: 'Routine',
}

interface NotificationsState {
  /** What this build sent on the doctor's behalf — kept, newest first. */
  sent: Notice[]
  send: (n: Omit<Notice, 'id' | 'direction' | 'at'> & { at?: string }) => Notice
}

let seq = 0

export const useNotifications = create<NotificationsState>()(
  persist(
    (set, get) => ({
      sent: [],
      send: (n) => {
        const notice: Notice = { ...n, id: `N-S-${Date.now().toString(36)}-${++seq}`, direction: 'out', at: n.at ?? new Date().toISOString() }
        set({ sent: [notice, ...get().sent] })
        return notice
      },
    }),
    { name: 'shri.notifications', version: 1 },
  ),
)
