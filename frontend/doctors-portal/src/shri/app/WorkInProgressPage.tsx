/**
 * SHRI_HEALTH: the doctors' portal's "Work in progress" screen, for a menu item whose service comes
 * after the demo (orders and referrals: Thulasi, after the demo; Vimal on #85, 18 Nov). Never an
 * error, a blank page or sample data: the screen says plainly that the feature is on its way. The
 * doctors' portal's own frame, tokens and primitives (sh-), never the shared design system's.
 */
import { Construction } from 'lucide-react'

import type { WorkInProgressFeature } from '../logic/workInProgress'
import { EmptyState } from '../ui/EmptyState'
import { Card } from '../ui/primitives'
import { ScreenFrame } from './ScreenFrame'


const COPY: Record<WorkInProgressFeature, { screenId: string; heading: string; why: string }> = {
  orders: {
    screenId: 'S-09-02',
    heading: 'Orders',
    why: 'This feature is work in progress. Lab and imaging orders, with their status from the lab, will appear here.',
  },
  referrals: {
    screenId: 'S-05-06',
    heading: 'Referrals',
    why: 'This feature is work in progress. Referrals you send and receive, with their status, will appear here.',
  },
}

export function WorkInProgressPage({ feature }: { feature: WorkInProgressFeature }) {
  const copy = COPY[feature]
  return (
    <ScreenFrame screenId={copy.screenId} heading={copy.heading}>
      <Card>
        <section aria-label="Work in progress">
          <EmptyState icon={Construction} why={copy.why} />
        </section>
      </Card>
    </ScreenFrame>
  )
}
