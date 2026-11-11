// TEMPORARY MOCK DATA — no notification service exists yet (plan §18).
// Tiers follow UI_ATLAS GP-04: critical / urgent / routine / digest.
// Operational content only — nothing clinical.

export type NotificationTier = 'critical' | 'urgent' | 'routine' | 'digest'

export interface Notification {
  id: string
  tier: NotificationTier
  text: string
  time: string
}

// Kept in step with the seed data: each one points at a record that exists.
export const notifications: Notification[] = [
  {
    id: 'ntf-1',
    tier: 'critical',
    text: 'MLC/0002 — police acknowledgement awaited · Mohan Raj',
    time: '2 hr ago',
  },
  {
    id: 'ntf-2',
    tier: 'urgent',
    text: 'Guest pass overdue — GP/PRIVATE WARD/102 · Abdul Rahman',
    time: '25 min ago',
  },
  {
    id: 'ntf-3',
    tier: 'routine',
    text: 'Patient called in — R. Lakshmanan · Dr. Arun Kumar',
    time: '14 min ago',
  },
]
