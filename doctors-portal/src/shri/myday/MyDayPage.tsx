/**
 * §5 — My Day (`/`). Greeting, the KPI strip and Today (`TodayPanel` — the
 * day's timeline, what comes next, the free slots) run the full width; under
 * them the main column (Patients Today / Needs Action) sits beside the right
 * column (Calendar / To-do):
 *
 *   ≥ 1024   right column 372px (362px below 1280 — the narrowest that keeps
 *            calendar days 44px wide); the two columns together one viewport
 *            high (never under 780px), each card scrolling inside
 *   < 1024   the right column moves below the main column
 *
 * The order never changes, so on a phone it reads Greeting → KPI → Today →
 * Patients Today → Needs Action → Calendar → To-do. Today follows the
 * calendar's chosen day, so the two always show the same one.
 *
 * The screen states are the old S-06-01's (`src/screens/m06/S0601.tsx`):
 * LOADING, EMPTY with its copy, OFFLINE and STALE above the KPIs, AI-OFF's one
 * quiet line, and — what C-37 promises — the mark-seen queue syncing, with a
 * toast, the moment the device is back online.
 */

import { BellRing } from 'lucide-react'
import { useEffect } from 'react'

import { NOW } from '@/data/format'
import { patient } from '@/data/kit'
import { useClinical } from '@/store/clinical'
import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import { useForcedState } from '../state/ai'
import { useShri } from '../state/store'
import { Card, RoundButton, Skeleton } from '../ui/primitives'
import { AiOffLine, ErrorFrame, OfflineStrip, StaleChip } from '../ui/states'

import { Greeting } from './Greeting'
import { KpiStrip } from './KpiStrip'
import { Calendar } from './Calendar'
import { NeedsAction } from './NeedsAction'
import { PatientsToday } from './PatientsToday'
import { TodayPanel } from './TodayPanel'
import { TodoNotes } from './TodoNotes'
import { useMyDay } from './useMyDay'

/** The viewport less the app bar, its margin and the surface padding (`--myday-h` in tokens.css). */
const LOWER_H = 'lg:h-(--myday-h)'

export function MyDayPage() {
  const forcedState = useForcedState()
  const pendingSeen = useClinical((s) => s.pendingSeen)
  const flushPendingSeen = useClinical((s) => s.flushPendingSeen)
  const toast = useUI((s) => s.toast)

  // C-37's promise kept: what was queued while offline actually syncs.
  useEffect(() => {
    if (forcedState !== 'OFFLINE' && pendingSeen.length > 0) {
      const n = pendingSeen.length
      flushPendingSeen(NOW.toISOString())
      toast({ tone: 'success', title: `${n} queued ${n === 1 ? 'update' : 'updates'} synced`, detail: 'Nothing was lost while you were offline.' })
    }
  }, [forcedState, pendingSeen, flushPendingSeen, toast])

  if (forcedState === 'LOADING') return <PageSkeleton />

  return (
    <div data-screen-id="S-06-01" className="flex flex-col">
      <div className="flex items-start justify-between gap-[12px]">
        <Greeting />
        {/* A demo control, DEV-only and desktop-only, as in the old build. */}
        {import.meta.env.DEV && <SimulateCritical />}
      </div>

      {forcedState === 'OFFLINE' && <OfflineStrip className="mt-[14px]" />}
      {forcedState === 'STALE' && <StaleChip className="mt-[14px] self-start" />}
      {forcedState === 'AI-OFF' && <AiOffLine className="mt-[14px]" />}

      <KpiStrip />

      {forcedState === 'ERROR' ? (
        <ErrorFrame className="mt-[14px]" />
      ) : forcedState === 'EMPTY' ? (
        <Card className="mt-[14px] flex-1 items-center justify-center text-center">
          <p className="text-[17px] font-medium text-sh-text">Nothing is waiting on you.</p>
          <p className="mt-[8px] max-w-[440px] text-[14px] text-sh-text-2">
            No session is open, you have no inpatients assigned, and nothing is left to review. A session starting or a patient being admitted under you
            would put something here.
          </p>
        </Card>
      ) : (
        <>
          <TodayPanel className="mt-[14px]" />
          <div className={cn('mt-[20px] grid min-h-0 grid-cols-1 gap-[20px] md:grid-cols-[minmax(0,1fr)_362px] lg:grid-cols-[minmax(0,1fr)_372px]', LOWER_H)}>
            <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-[16px] max-lg:grid-rows-none">
              <PatientsToday />
              <NeedsAction />
            </div>
            <aside className="flex min-h-0 flex-col gap-[16px]">
              <Calendar />
              {/* The week's day detail takes the larger share; the to-do list the rest, scrolling inside. */}
              <TodoNotes className="flex-[2]" />
            </aside>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Acceptance test 7. There is no backend and no service worker, so a "push" is
 * simulated: a critical toast, plus a real Notification where the browser
 * grants one, and the Quick-Panel opens on the patient.
 */
function SimulateCritical() {
  const { ranked } = useMyDay()
  const toast = useUI((s) => s.toast)
  const openQuickPanel = useShri((s) => s.openQuickPanel)

  function simulate() {
    const worst = ranked.find((i) => i.urgency === 'critical') ?? ranked[0]
    if (!worst) return
    const p = patient(worst.patientId)
    toast({ tone: 'critical', title: `${worst.reason} — ${p.name}`, detail: worst.detail })
    if ('Notification' in window) {
      void Notification.requestPermission().then((granted) => {
        if (granted === 'granted') new Notification(`${worst.reason} — ${p.name}`, { body: worst.detail })
      })
    }
    openQuickPanel(worst)
  }

  return <RoundButton icon={BellRing} size={44} variant="control" label="Simulate a critical event (demo)" className="max-lg:hidden" onClick={simulate} />
}

/** §11 LOADING — blocks where the cards will be. */
function PageSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true" aria-label="Loading Dashboard">
      <Skeleton className="h-[36px] w-[360px] max-w-full" />
      <Skeleton className="mt-[8px] h-[18px] w-[420px] max-w-full" />
      <div className="mb-[2px] mt-[14px] grid h-[74px] grid-cols-6 gap-[12px] max-lg:h-auto max-lg:grid-cols-3 max-sm:flex max-sm:overflow-hidden">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[74px] rounded-sh-kpi max-sm:w-[min(52vw,212px)] max-sm:shrink-0" />
        ))}
      </div>
      <SkeletonCard rows={5} className="mt-[14px]" />
      <div className={cn('mt-[20px] grid min-h-0 grid-cols-1 gap-[20px] md:grid-cols-[minmax(0,1fr)_362px] lg:grid-cols-[minmax(0,1fr)_372px]', LOWER_H)}>
        <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-[16px]">
          <SkeletonCard rows={7} />
          <SkeletonCard rows={4} />
        </div>
        <aside className="flex min-h-0 flex-col gap-[16px]">
          <SkeletonCard rows={5} />
          <SkeletonCard rows={3} className="flex-1" />
        </aside>
      </div>
    </div>
  )
}

function SkeletonCard({ rows, className }: { rows: number; className?: string }) {
  return (
    <Card className={cn('gap-[10px]', className)}>
      <Skeleton className="mb-[6px] h-[22px] w-[140px]" />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-[40px]" />
      ))}
    </Card>
  )
}
