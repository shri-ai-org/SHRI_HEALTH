/**
 * The frame every patient-record screen (S-06-11 … S-06-17) uses, as the old
 * build's `RecordScreen` did (`src/screens/m06/record/shared.tsx:109-156`):
 * the patient banner, the header, the parts as tabs, then the one part. An
 * unknown id says so rather than silently showing someone else. The old
 * frame's states: OFFLINE under the banner, STALE beside the actions, AI-OFF's
 * one quiet line, and LOADING / EMPTY / ERROR in place of the part — the
 * banner stays, so the doctor still knows whose record it is. DENIED replaces
 * the whole screen (the route wrapper), because it shows no patient at all.
 */

import { UserX } from 'lucide-react'
import type { ReactNode } from 'react'

import { screen, type ScreenSpec } from '@/atlas/registry'
import { patientByAnyId, type Patient } from '@/data/kit'

import { SECTION_META, useDefaultSubheading, type RecordSection } from '../logic/record'
import { useForcedState } from '../state/ai'
import { Card, Icon, Skeleton } from '../ui/primitives'
import { AiOffLine, ErrorFrame, OfflineStrip } from '../ui/states'

import { ScreenHeader } from '../app/ScreenHeader'

import { PatientBanner } from './PatientBanner'
import { RecordTabs } from './RecordTabs'

export function RecordFrame({
  id,
  section,
  sub,
  actions,
  children,
}: {
  id?: string
  section: RecordSection
  sub?: (p: Patient) => ReactNode
  actions?: (p: Patient) => ReactNode
  children: (p: Patient) => ReactNode
}) {
  const p = patientByAnyId(id)
  const spec = screen(SECTION_META[section].screenId)
  const forced = useForcedState()

  if (!p) {
    return (
      <div data-screen-id={spec.id} className="flex flex-col gap-[16px] pb-[8px]">
        <ScreenHeader spec={spec} sub="No patient at this address." />
        <Card className="max-w-[640px] flex-row items-start gap-[14px]">
          <span className="inline-flex size-[44px] shrink-0 items-center justify-center rounded-full bg-sh-inner text-sh-text-2" aria-hidden="true">
            <Icon icon={UserX} size={20} />
          </span>
          <p className="pt-[10px] text-[14px]/[1.5] text-sh-text-2">
            There is no patient with the id &ldquo;{id ?? ''}&rdquo; in this sample record. Search with / to find the patient you meant.
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div data-screen-id={spec.id} className="flex flex-col gap-[16px] pb-[8px]">
      <PatientBanner patient={p} />
      {forced === 'OFFLINE' && <OfflineStrip />}
      <RecordHeader spec={spec} patient={p} sub={sub?.(p)} actions={actions?.(p)} />
      <RecordTabs patient={p} current={section} />
      {forced === 'AI-OFF' && <AiOffLine />}
      <div id="record-panel" role="tabpanel" aria-labelledby={`record-tab-${section}`} className="flex min-w-0 flex-col gap-[16px]">
        {forced === 'LOADING' ? (
          <PartSkeleton />
        ) : forced === 'EMPTY' ? (
          <Card>
            <p className="text-center text-[14px] text-sh-text-2">Nothing to show here yet, and the reason is stated on the screen this stands in for.</p>
          </Card>
        ) : forced === 'ERROR' ? (
          <ErrorFrame />
        ) : (
          children(p)
        )}
      </div>
    </div>
  )
}

/** LOADING — blocks where the cards will be, never a spinner on a blank page. */
function PartSkeleton() {
  return (
    <div className="flex flex-col gap-[16px]" aria-busy="true" aria-label="Loading the record">
      <div className="grid grid-cols-[5fr_4fr_4fr] gap-[16px] max-lg:grid-cols-1">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="gap-[10px]">
            <Skeleton className="mb-[6px] h-[22px] w-[140px]" />
            <Skeleton className="h-[160px]" />
          </Card>
        ))}
      </div>
      <Card className="gap-[10px]">
        <Skeleton className="mb-[6px] h-[22px] w-[140px]" />
        <Skeleton className="h-[120px]" />
      </Card>
    </div>
  )
}

/** The header, with the default sub-line read from the live book (so a moved appointment shows as the new "next"). */
function RecordHeader({ spec, patient: p, sub, actions }: { spec: ScreenSpec; patient: Patient; sub?: ReactNode; actions?: ReactNode }) {
  const fallback = useDefaultSubheading(p)
  return <ScreenHeader spec={spec} sub={sub ?? fallback} actions={actions} />
}
