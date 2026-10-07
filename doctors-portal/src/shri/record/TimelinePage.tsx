/**
 * S-06-06 · Clinical timeline — `/patient/:id/timeline` (`src/screens/m06/
 * S0606.tsx`): the whole record, in time order, unsummarised. The spine is
 * deliberately the raw record — this is the screen the chart summary's
 * guardrail points at when it says the unsummarised record is always one
 * click away. Today is open, every earlier day is behind one fold, and an AI
 * touch on an entry is one quiet word rather than a chip. The entry type is
 * kept in the address (`?kind=`), as the old screen kept it.
 *
 * Old defects fixed: an unknown id showed R. Lakshmanan's timeline instead of
 * saying so; and AI-105's summary was his, offered on every patient's
 * timeline. It is offered only on the record it describes.
 */

import { Activity, BedDouble, Circle, ClipboardList, FileText, FlaskConical, Pill as PillIcon, ScanLine, Sparkles, UserX, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'

import { screen } from '@/atlas/registry'
import type { TimelineEvent } from '@/data/clinical'
import { NOW, formatDate, formatDateTime, formatTime } from '@/data/format'
import { patientByAnyId } from '@/data/kit'
import { recordTimelineFor } from '@/data/timeline'

import { ScreenFrame } from '../app/ScreenFrame'
import { ScreenHeader } from '../app/ScreenHeader'
import { useScope } from '../logic/scope'
import { useAiActive } from '../state/ai'
import { WhyLink } from '../ui/ai'
import { Disclosure, Why } from '../ui/Disclosure'
import { EmptyState } from '../ui/EmptyState'
import { Card, ConfidenceMark, CountBubble, Diamond, Icon, Pill } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'

type Kind = TimelineEvent['kind'] | 'all'

const KINDS: { key: Kind; label: string; icon?: LucideIcon }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'note', label: 'Notes', icon: FileText },
  { key: 'result', label: 'Test results', icon: FlaskConical },
  { key: 'medication', label: 'Medication', icon: PillIcon },
  { key: 'order', label: 'Orders', icon: ClipboardList },
  { key: 'imaging', label: 'Imaging reports', icon: ScanLine },
  { key: 'vitals', label: 'Observations', icon: Activity },
]
const KIND_KEYS = KINDS.map((k) => k.key)

const ICON_FOR: Record<TimelineEvent['kind'], LucideIcon> = {
  note: FileText,
  order: ClipboardList,
  result: FlaskConical,
  medication: PillIcon,
  vitals: Activity,
  admission: BedDouble,
  imaging: ScanLine,
  ai: Sparkles,
}

/** AI-105's précis — of R. Lakshmanan's record, and so only on it (the old screen showed it on everyone's). */
const SUMMARIES: Record<string, string> = {
  'SD-P-03':
    'Admitted on 17-Sep and started on broad antibiotic cover the same afternoon. Imaging on 19-Sep confirmed a right lower lobe consolidation with no effusion. The turning point is overnight on 20/21-Sep: oxygen doubled at 04:20, the deterioration score reached 7 and rising, and CRP came back nearly doubled. The blood culture is still negative, so the organism is unknown at 72 hours.',
}

export function TimelinePage() {
  const { id } = useParams()
  const p = patientByAnyId(id)
  if (!p) {
    const spec = screen('S-06-06')
    return (
      <div data-screen-id={spec.id} className="flex flex-col gap-[16px] pb-[8px]">
        <ScreenHeader spec={spec} heading="Timeline" sub="No patient at this address." />
        <Card className="max-w-[640px]">
          <EmptyState icon={UserX} why={`There is no patient with the id “${id ?? ''}” in this sample record. Search with / to find the patient you meant.`} />
        </Card>
      </div>
    )
  }
  return <Timeline patientId={p.id} />
}

function Timeline({ patientId }: { patientId: string }) {
  const p = patientByAnyId(patientId)!
  const aiActive = useAiActive()
  const [kind, setKind] = useScope<Kind>(KIND_KEYS, 'all', 'kind')
  const [summaryOpen, setSummaryOpen] = useState(false)
  const summary = SUMMARIES[p.id]

  const events = recordTimelineFor(p.id)
  const filtered = kind === 'all' ? events : events.filter((e) => e.kind === kind)
  const today = formatDate(NOW)
  const todayCount = events.filter((e) => formatDate(e.at) === today).length
  const aiTouched = events.filter((e) => e.ai).length

  /** Grouped by day, since a clinician reads a record by day, not by row. */
  const byDay = useMemo(() => {
    const map = new Map<string, TimelineEvent[]>()
    for (const e of filtered) {
      const key = formatDate(e.at)
      map.set(key, [...(map.get(key) ?? []), e])
    }
    return [...map.entries()]
  }, [filtered])
  const todayEvents = byDay.find(([day]) => day === today)?.[1] ?? []
  const earlierDays = byDay.filter(([day]) => day !== today)

  return (
    <ScreenFrame
      screenId="S-06-06"
      patient={p}
      heading="Timeline"
      sub={`${todayCount} ${todayCount === 1 ? 'entry' : 'entries'} today · ${events.length} in the record · unsummarised`}
      rail={
        <Card titleSize="sm" title="Summary">
          {summary && aiActive && (
            <Pill variant={summaryOpen ? 'control' : 'accent'} size="lg" icon={Sparkles} className="w-full" aria-expanded={summaryOpen} onClick={() => setSummaryOpen((v) => !v)}>
              {summaryOpen ? 'Hide the summary' : 'Summarise this timeline'}
            </Pill>
          )}
          <Why className="mt-[12px]">
            <p>
              This screen is the unsummarised record on purpose.{summary ? ' A summary is available, but it is the option here, not the default.' : ''}
            </p>
            <p>
              Where AI touched the record: {aiTouched} {aiTouched === 1 ? 'entry carries' : 'entries carry'} the word &ldquo;AI-assisted&rdquo;. Every one of them
              has a recorded human disposition — the word is disclosure, not credit.
            </p>
          </Why>
        </Card>
      }
      railTitle="Timeline"
    >
      {aiActive && summaryOpen && summary && (
        <Card
          titleSize="sm"
          title={
            <span className="inline-flex items-center gap-[8px]">
              <Diamond />
              Timeline summary
            </span>
          }
          right={
            <span className="flex items-center gap-[12px]">
              <ConfidenceMark band="MED" score={0.77} />
              <WhyLink
                target={{
                  touchpointId: `timeline-${p.id}`,
                  capabilityId: 'AI-105',
                  claim: 'A chronological précis of this record, with the turning points named.',
                  confidence: 0.77,
                  band: 'MED',
                  computedAt: formatTime(NOW),
                  inputs: events.slice(0, 6).map((e) => ({ label: e.label, source: formatDateTime(e.at) })),
                  evidence: ['Assembled from the entries below — nothing outside this timeline.'],
                  model: 'chart-sum v3.4.0',
                  limits: [
                    'Summarises what is charted, in the order it was charted.',
                    'A late entry about an early event will read as late here.',
                    'The entries below are the authoritative version.',
                  ],
                }}
              />
            </span>
          }
          className="shadow-[inset_0_0_0_1.5px_var(--flags-ring)]"
        >
          <p className="text-[14px]/[1.6] text-sh-text-2">{summary}</p>
        </Card>
      )}

      <Segmented
        label="Entry type"
        value={kind}
        onChange={setKind}
        options={KINDS.map((k) => ({ key: k.key, label: k.label, icon: k.icon, count: k.key === 'all' ? undefined : events.filter((e) => e.kind === k.key).length }))}
      />

      {byDay.length === 0 ? (
        <p className="px-[4px] py-[24px] text-center text-[14px] text-sh-text-2">Nothing of this type is recorded for this patient. Switch the filter, or choose Everything.</p>
      ) : (
        <>
          <Card
            titleSize="sm"
            title={
              <span className="inline-flex items-center gap-[10px]">
                Today
                <CountBubble className="bg-sh-control">{todayEvents.length}</CountBubble>
              </span>
            }
          >
            {todayEvents.length === 0 ? (
              <p className="text-[14px] text-sh-text-2">Nothing {kind === 'all' ? '' : 'of this type '}has been recorded today. Earlier days are below.</p>
            ) : (
              <DayList events={todayEvents} />
            )}
          </Card>

          {earlierDays.length > 0 && (
            <Disclosure label="earlier days" count={earlierDays.length}>
              <div className="flex flex-col gap-[12px]">
                {earlierDays.map(([day, dayEvents]) => (
                  <Card
                    key={day}
                    titleSize="sm"
                    title={
                      <span className="inline-flex items-center gap-[10px] tabular-nums">
                        {day}
                        <CountBubble className="bg-sh-control">{dayEvents.length}</CountBubble>
                      </span>
                    }
                  >
                    <DayList events={dayEvents} />
                  </Card>
                ))}
              </div>
            </Disclosure>
          )}
        </>
      )}
    </ScreenFrame>
  )
}

/** One day's entries. The row is the entry; provenance is one quiet word. */
function DayList({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="flex flex-col">
      {events.map((e, i) => (
        <li key={`${e.at.toISOString()}-${i}`} className={i > 0 ? 'flex min-h-[44px] gap-[12px] border-t border-sh-line py-[12px]' : 'flex min-h-[44px] gap-[12px] pb-[12px]'}>
          <span className="w-[48px] shrink-0 pt-[2px] text-[12px] tabular-nums text-sh-text-3">{formatTime(e.at)}</span>
          <span className="inline-flex size-[28px] shrink-0 items-center justify-center rounded-full bg-sh-inner text-sh-text-3" aria-hidden="true">
            <Icon icon={ICON_FOR[e.kind] ?? Circle} size={13} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-[6px] text-[14px] font-medium text-sh-text">
              {/* The ◆ only where the entry IS an AI entry — once, on the header. */}
              {e.kind === 'ai' && <Diamond />}
              {e.label}
            </span>
            <span className="mt-[2px] block text-[13px] text-sh-text-2">{e.detail}</span>
            <span className="mt-[4px] block text-[12px] text-sh-text-3">
              {e.by}
              {e.ai && ' · AI-assisted'}
            </span>
          </span>
        </li>
      ))}
    </ol>
  )
}
