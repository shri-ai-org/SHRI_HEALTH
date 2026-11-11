/**
 * The frame a screen composes, as the old build's `Screen` did
 * (`src/shell/Screen.tsx`): the patient banner where the screen is
 * patient-scoped (Z3), the offline strip under it, the header (Z4), AI-OFF's
 * one quiet line, then the work with its rail (Z5 + Z6), and the sticky action
 * bar (Z7a). LOADING, EMPTY and ERROR take the work's place and leave the
 * banner and the heading, so the doctor still knows where they are; DENIED
 * replaces the whole screen (the route wrapper), because it shows no patient.
 */

import type { ReactNode } from 'react'

import { screen } from '@/atlas/registry'
import type { Patient } from '@/data/kit'

import { PatientBanner } from '../record/PatientBanner'
import { useForcedState } from '../state/ai'
import { ActionBar } from '../ui/ActionBar'
import { Card, Skeleton } from '../ui/primitives'
import { WithRail } from '../ui/Rail'
import { AiOffLine, ErrorFrame, OfflineStrip, StaleChip } from '../ui/states'

import { ScreenHeader } from './ScreenHeader'

export function ScreenFrame({
  screenId,
  patient,
  bannerExtra,
  heading,
  sub,
  chips,
  actions,
  rail,
  railTitle = 'Context',
  railBadge,
  actionBar,
  empty,
  children,
}: {
  screenId: string
  patient?: Patient
  bannerExtra?: ReactNode
  heading?: ReactNode
  sub?: ReactNode
  chips?: ReactNode
  actions?: ReactNode
  rail?: ReactNode
  railTitle?: string
  railBadge?: number
  actionBar?: ReactNode
  /** Drawn when the forced state is EMPTY. */
  empty?: ReactNode
  children: ReactNode
}) {
  const spec = screen(screenId)
  const forced = useForcedState()
  const replaces = forced === 'LOADING' || forced === 'EMPTY' || forced === 'ERROR'

  return (
    <div data-screen-id={spec.id} className="flex min-h-(--frame-min-h) flex-col gap-[16px] pb-[8px]">
      {patient && <PatientBanner patient={patient} extra={bannerExtra} />}
      {forced === 'OFFLINE' && <OfflineStrip />}
      <ScreenHeader
        spec={spec}
        heading={heading}
        sub={sub}
        chips={chips}
        // STALE, as the old frame drew it: the amber "Data as of" chip beside the actions (`src/shell/Screen.tsx:229`).
        actions={
          forced === 'STALE' ? (
            <>
              <StaleChip />
              {actions}
            </>
          ) : (
            actions
          )
        }
      />
      {forced === 'AI-OFF' && <AiOffLine />}
      {forced === 'LOADING' ? (
        <div className="flex flex-col gap-[16px]" aria-busy="true" aria-label={`Loading ${spec.name}`}>
          {[0, 1].map((i) => (
            <Card key={i} className="gap-[10px]">
              <Skeleton className="mb-[6px] h-[22px] w-[160px]" />
              <Skeleton className="h-[48px]" />
              <Skeleton className="h-[48px]" />
            </Card>
          ))}
        </div>
      ) : forced === 'EMPTY' ? (
        (empty ?? (
          <Card>
            <p className="text-center text-[14px] text-sh-text-2">Nothing to show here yet, and the reason is stated on the screen this stands in for.</p>
          </Card>
        ))
      ) : forced === 'ERROR' ? (
        <ErrorFrame />
      ) : (
        <WithRail rail={rail} title={railTitle} badge={railBadge}>
          {children}
        </WithRail>
      )}
      {/* Pushed to the frame's foot, so on a short screen it still rests at the bottom of the viewport. */}
      {actionBar && !replaces && <ActionBar className="mt-auto">{actionBar}</ActionBar>}
    </div>
  )
}
