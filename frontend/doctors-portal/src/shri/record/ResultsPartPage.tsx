/**
 * S-06-13 · Test results — `/patient/:id/results` (`src/screens/m06/record/
 * S0613.tsx`): one patient's results, grouped by test, with the trend beside
 * each. The results inbox is organised around the doctor's day; this is
 * organised around one patient's body — so a test appears once, with its
 * latest value, its flag in words, the reference range and, where there is a
 * series, the shape of the trend. Each row opens the full result. Cultures
 * and other microbiology follow in their own card — what was sent, what grew,
 * and the sensitivities, with any allergy on the record beside its drug.
 */

import { ChevronRight, FlaskConical, Microscope, OctagonAlert } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { RESULT_TRENDS, resultsFor, type ResultRow } from '@/data/clinical'
import { formatDate, formatTime } from '@/data/format'
import type { Patient } from '@/data/kit'
import { allergyFor, microFor, type MicroResult, type Susceptibility } from '@/data/results-ext'
import { useClinical } from '@/store/clinical'

import { useAiActive } from '../state/ai'
import { EmptyState } from '../ui/EmptyState'
import { Card, Chip, CountBubble, Diamond, Icon } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'
import { Sparkline } from '../ui/Sparkline'
import { StatTile } from '../ui/StatTile'

import { ClinicalFlag } from './bits'
import { RecordFrame } from './RecordFrame'

type Filter = 'all' | 'abnormal' | 'review'

export function ResultsPartPage() {
  const { id } = useParams()
  return (
    <RecordFrame id={id} section="results">
      {(p) => <Results patient={p} />}
    </RecordFrame>
  )
}

function Results({ patient: p }: { patient: Patient }) {
  const acknowledgements = useClinical((s) => s.acknowledgements)
  const [filter, setFilter] = useState<Filter>('all')
  const all = resultsFor(p.id)
  const isReviewed = (r: ResultRow) => r.acknowledged || Boolean(acknowledgements[r.id])
  const abnormal = all.filter((r) => r.flag !== 'Normal')
  const review = all.filter((r) => !isReviewed(r))
  const critical = all.filter((r) => r.critical)
  const shown = filter === 'abnormal' ? abnormal : filter === 'review' ? review : all

  return (
    <>
      <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-3">
        <StatTile label="Results on file" value={all.length} sub={all[0] ? `latest ${formatDate(all[0].reportedAt)}` : 'none yet'} />
        <StatTile
          label="Outside range"
          value={abnormal.length}
          tone={critical.length > 0 ? 'crit' : abnormal.length > 0 ? 'warn' : 'norm'}
          sub={critical.length > 0 ? `${critical.length} critical` : abnormal.length > 0 ? 'high or low' : 'all within range'}
        />
        <StatTile
          label="To review"
          value={review.length}
          tone={review.length > 0 ? 'warn' : 'norm'}
          sub={review.length > 0 ? 'not yet acknowledged' : 'everything reviewed'}
        />
      </div>

      <Card
        titleSize="sm"
        title={
          <span className="inline-flex items-center gap-[10px]">
            Test results
            <CountBubble className="bg-sh-control">{all.length}</CountBubble>
          </span>
        }
        right={
          <Segmented
            label="Which results"
            value={filter}
            onChange={setFilter}
            options={[
              { key: 'all', label: 'All', count: all.length },
              { key: 'abnormal', label: 'Outside range', count: abnormal.length },
              { key: 'review', label: 'To review', count: review.length },
            ]}
          />
        }
        headerClassName="flex-wrap gap-y-[10px]"
      >
        {shown.length === 0 ? (
          <EmptyState
            icon={FlaskConical}
            why={
              all.length === 0
                ? `No results are on ${p.name}’s record yet. A sample sent from any order would appear here once reported.`
                : 'Nothing in this group. Choose All to see every result.'
            }
          />
        ) : (
          <ul aria-label="Test results" className="-mx-[8px] flex flex-col">
            {shown.map((r, i) => (
              <ResultLine key={r.id} r={r} reviewed={isReviewed(r)} first={i === 0} />
            ))}
          </ul>
        )}
      </Card>

      <Microbiology patient={p} />
    </>
  )
}

const SUSCEPTIBILITY: Record<Susceptibility, { word: string; tone: 'norm' | 'warn' | 'crit' }> = {
  S: { word: 'Sensitive', tone: 'norm' },
  I: { word: 'Intermediate', tone: 'warn' },
  R: { word: 'Resistant', tone: 'crit' },
}

/** Cultures, microscopy and molecular tests — drawn only when the patient has any. */
function Microbiology({ patient: p }: { patient: Patient }) {
  const micro = microFor(p.id)
  if (micro.length === 0) return null
  return (
    <Card
      titleSize="sm"
      title={
        <span className="inline-flex items-center gap-[10px]">
          Microbiology
          <CountBubble className="bg-sh-control">{micro.length}</CountBubble>
        </span>
      }
    >
      <ul aria-label="Microbiology" className="flex flex-col">
        {micro.map((m, i) => (
          <MicroLine key={m.id} m={m} allergies={p.allergies} first={i === 0} />
        ))}
      </ul>
    </Card>
  )
}

function MicroLine({ m, allergies, first }: { m: MicroResult; allergies: string[]; first: boolean }) {
  return (
    <li className={first ? 'pb-[14px]' : 'border-t border-sh-line py-[14px]'} aria-label={`${m.test}, ${m.status.toLowerCase()}`}>
      <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[4px]">
        <Icon icon={Microscope} size={15} className="text-sh-text-2" />
        <span className="text-[14px] font-semibold text-sh-text">{m.test}</span>
        <Chip word={m.status} tone={m.status === 'Final' ? 'neu' : 'warn'} />
      </div>
      <p className="mt-[4px] text-[12px] tabular-nums text-sh-text-3">
        {m.specimen} · collected {formatDate(m.collectedAt)} {formatTime(m.collectedAt)} · reported {formatDate(m.reportedAt)} {formatTime(m.reportedAt)}
      </p>
      {m.gram && <p className="mt-[8px] text-[13px] text-sh-text-2">{m.gram}</p>}
      <p className="mt-[6px] text-[15px] font-medium text-sh-text">
        {m.growth}
        {m.count && <span className="ml-[6px] text-[13px] font-normal tabular-nums text-sh-text-2">{m.count}</span>}
      </p>
      {m.sensitivities && (
        <ul aria-label={`Sensitivities — ${m.test}`} className="mt-[10px] grid grid-cols-1 gap-x-[16px] gap-y-[6px] rounded-[14px] bg-sh-inner px-[14px] py-[10px] sm:grid-cols-2">
          {m.sensitivities.map((x) => {
            const allergy = allergyFor(x.drug, allergies)
            const t = SUSCEPTIBILITY[x.result]
            return (
              <li key={x.drug} className="flex min-w-0 flex-wrap items-center justify-between gap-[8px] text-[13px]">
                <span className="min-w-0 text-sh-text">
                  {x.drug}
                  {allergy && (
                    <span className="ml-[6px] inline-flex items-center gap-[4px] text-[12px] font-medium text-sh-crit-fg">
                      <Icon icon={OctagonAlert} size={12} />
                      {allergy} allergy on record
                    </span>
                  )}
                </span>
                <Chip word={t.word} tone={t.tone} />
              </li>
            )
          })}
        </ul>
      )}
      {m.comment && <p className="mt-[8px] text-[12px] text-sh-text-3">{m.comment}</p>}
    </li>
  )
}

function ResultLine({ r, reviewed, first }: { r: ResultRow; reviewed: boolean; first: boolean }) {
  const navigate = useNavigate()
  const aiActive = useAiActive()
  const series = RESULT_TRENDS[r.id] ?? []

  return (
    <li className={first ? undefined : 'border-t border-sh-line'}>
      <button
        type="button"
        onClick={() => navigate(`/results/${r.id}`)}
        className="grid min-h-[44px] w-full gap-x-[16px] gap-y-[6px] rounded-[14px] px-[8px] py-[12px] text-left transition-colors duration-150 hover:bg-sh-hover sm:grid-cols-[minmax(0,1fr)_auto]"
      >
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-x-[8px] gap-y-[4px]">
            <span className="text-[14px] font-semibold text-sh-text">{r.test}</span>
            <ClinicalFlag flag={r.flag} />
            {!reviewed && <Chip word="To review" tone="warn" />}
          </span>
          <span className="mt-[4px] block text-[12px] tabular-nums text-sh-text-3">
            {formatDate(r.reportedAt)} {formatTime(r.reportedAt)} · range {r.refRange}
            {r.unit ? ` ${r.unit}` : ''}
            {r.priorValue && ` · before ${r.priorValue}`}
            {r.delta && ` (${r.delta})`}
          </span>
          {aiActive && (
            <span className="mt-[4px] flex items-start gap-[6px] text-[13px] text-sh-text-2">
              <Diamond className="mt-[3px]" />
              {r.aiReason}
            </span>
          )}
        </span>
        <span className="flex items-center gap-[12px] sm:justify-end">
          {series.length > 1 ? (
            <Sparkline points={series.map((pt) => ({ at: pt.at, value: pt.value }))} unit={r.unit} label={r.test} />
          ) : (
            <span className="text-[18px] font-semibold tabular-nums text-sh-text">
              {r.value}
              {r.unit && <span className="ml-[4px] text-[12px] font-normal text-sh-text-3">{r.unit}</span>}
            </span>
          )}
          <Icon icon={ChevronRight} size={16} className="text-sh-chev" />
        </span>
      </button>
    </li>
  )
}
