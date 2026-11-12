/**
 * S-06-20 · History — `/patient/:id/history`: the patient's past problems and their surgical, family
 * and social history, each a short read-only list (gap 86; Vimal on #85, Minalini's D115 exception:
 * no source screen). Built like the Current condition page (S-06-15): the record frame, one card per
 * list. The active problem list stays on Current condition; here are only the resolved, inactive or
 * in-remission ones. With the API only (shri-health/history.ts); editing comes after the demo.
 */
import { ClipboardList, HeartHandshake, Scissors, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useParams } from 'react-router-dom'
import type { Patient } from '@/data/kit'
import { usePatientHistory, type HistoryList } from '../../../shri-health/history'
import { cn } from '../lib/cn'
import { EmptyState } from '../ui/EmptyState'
import { Card, CountBubble } from '../ui/primitives'
import { RecordFrame } from './RecordFrame'

export function HistoryPage() {
  const { id } = useParams()
  return (
    <RecordFrame id={id} section="history">
      {(p) => <History patient={p} />}
    </RecordFrame>
  )
}

function History({ patient: p }: { patient: Patient }) {
  const h = usePatientHistory(p.id)
  return (
    <div className="grid grid-cols-1 gap-[16px] lg:grid-cols-2">
      <HistoryCard title="Past problems" icon={ClipboardList} list={h.pastProblems} />
      <HistoryCard title="Surgical history" icon={Scissors} list={h.surgical} />
      <HistoryCard title="Family history" icon={Users} list={h.family} />
      <HistoryCard title="Social history" icon={HeartHandshake} list={h.social} />
    </div>
  )
}

function HistoryCard({ title, icon, list }: { title: string; icon: LucideIcon; list: HistoryList }) {
  return (
    <Card
      titleSize="sm"
      title={
        <span className="inline-flex items-center gap-[10px]">
          {title}
          {!list.denied && <CountBubble className="bg-sh-control">{list.rows.length}</CountBubble>}
        </span>
      }
    >
      {list.denied ? (
        <EmptyState icon={icon} compact why="Your role can't read this." />
      ) : list.rows.length === 0 ? (
        <EmptyState icon={icon} compact why="None recorded." />
      ) : (
        <ul className="flex flex-col">
          {list.rows.map((r, i) => (
            <li key={r.id} className={cn('py-[10px]', i > 0 && 'border-t border-sh-line', i === 0 && 'pt-0')}>
              <span className="text-[14px] font-medium text-sh-text">{r.title}</span>
              {r.detail && <span className="block text-[12px] tabular-nums text-sh-text-3">{r.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
