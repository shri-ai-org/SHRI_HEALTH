/**
 * §5.6 — Attention (the old build's ranking, `attentionFor`: opens the
 * Quick-Panel; the mic dictates a note about that patient) beside Tasks (what
 * is left to sign or write, `toFinishFor`). No values here: those live in the
 * Quick-Panel. The ranking is AI-613's, and its guardrail is that the
 * deterministic order is always one click away.
 */

import { ChevronDown, ChevronRight, Mic, OctagonAlert, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { patient } from '@/data/kit'
import type { AttentionItem, FinishItem, Urgency } from '@/data/myday'

import { Menu, MenuRow } from '../app/menus/Menu'
import { canonical } from '../app/paths'
import { cn } from '../lib/cn'
import type { Tone } from '../mocks/types'
import { useShri } from '../state/store'
import { iconFor } from '../ui/icons'
import { Card, Diamond, Icon, Pill, PillTag, RoundButton, SectionLabel } from '../ui/primitives'

import { useMyDay, type MyDay } from './useMyDay'

const URGENCY_TONE: Record<Urgency, Tone> = { critical: 'crit', warning: 'warn', pending: 'pend' }

export function NeedsAction({ className }: { className?: string }) {
  const d = useMyDay()
  const [showRanking, setShowRanking] = useState(false)
  const ordered = d.ordered(showRanking)
  const critical = ordered.filter((i) => i.urgency === 'critical').length
  const warning = ordered.filter((i) => i.urgency === 'warning').length
  // The panel's meta: its top urgency, counted — the old build's line.
  const chip =
    ordered.length === 0
      ? null
      : critical > 0
        ? { text: `${critical} critical`, tone: 'crit' as const }
        : warning > 0
          ? { text: `${warning} ${warning === 1 ? 'warning' : 'warnings'}`, tone: 'warn' as const }
          : { text: `${ordered.length} pending`, tone: 'pend' as const }
  return (
    <Card
      className={className}
      title="Needs Action"
      right={
        chip && (
          <PillTag tone={chip.tone} size="sm" icon={OctagonAlert} iconSize={13} className="font-medium">
            {chip.text}
          </PillTag>
        )
      }
    >
      <div className="grid grid-cols-[minmax(0,1.25fr)_1px_minmax(0,1fr)] gap-[18px] max-md:grid-cols-1">
        <Attention d={d} ordered={ordered} showRanking={showRanking} onShowRanking={() => setShowRanking(true)} />
        <div className="w-px self-stretch bg-sh-line max-md:hidden" aria-hidden="true" />
        <Tasks items={d.toFinish} />
      </div>
    </Card>
  )
}

/* ----------------------------------------------------------- Attention */

function Attention({ d, ordered, showRanking, onShowRanking }: { d: MyDay; ordered: AttentionItem[]; showRanking: boolean; onShowRanking: () => void }) {
  const openQuickPanel = useShri((st) => st.openQuickPanel)
  const openNoteModal = useShri((st) => st.openNoteModal)
  const attentionSort = useShri((st) => st.attentionSort)
  const setAttentionSort = useShri((st) => st.setAttentionSort)
  const [menuOpen, setMenuOpen] = useState(false)

  const low = d.lowConfidence && d.aiActive
  const byAi = d.aiActive && attentionSort === 'ai'

  let sort: React.ReactNode
  if (!d.aiActive) {
    sort = <span className="text-[12px] font-medium text-sh-text-2">Sorted by time · AI ranking is off</span>
  } else if (low && !showRanking) {
    sort = null
  } else {
    sort = (
      <div className="relative">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          className="inline-flex h-[28px] items-center gap-[5px] rounded-full px-[8px] text-[12px] font-medium text-sh-text-2 transition-colors duration-150 hover:bg-sh-hover hover:text-sh-text"
        >
          {byAi && <Diamond />}
          {byAi ? 'Sorted by AI acuity' : 'Sorted by time'}
          <Icon icon={ChevronDown} size={13} className="text-sh-chev" />
        </button>
        <Menu open={menuOpen} onClose={() => setMenuOpen(false)} width={210} label="Sort attention">
          <MenuRow
            current={byAi}
            onClick={() => {
              setAttentionSort('ai')
              setMenuOpen(false)
            }}
          >
            <Diamond />
            <span className="text-[13px] font-medium">Sorted by AI acuity</span>
          </MenuRow>
          <MenuRow
            current={!byAi}
            onClick={() => {
              setAttentionSort('time')
              setMenuOpen(false)
            }}
          >
            <span className="text-[13px] font-medium">Sorted by time</span>
          </MenuRow>
        </Menu>
      </div>
    )
  }

  return (
    <section aria-label="Attention" className="min-w-0">
      <SectionLabel count={ordered.length} right={sort} className="mb-[8px]">
        Attention
      </SectionLabel>

      {/* §4.5 — LOW arrives collapsed and cannot be used until it is expanded. */}
      {low && !showRanking && ordered.length > 0 && (
        <div className="mb-[8px] rounded-[12px] bg-sh-warn-bg px-[12px] py-[8px] text-[12px] text-sh-warn-fg">
          <p className="flex items-center gap-[8px] font-semibold">
            <Icon icon={TriangleAlert} size={14} strokeWidth={2} />
            Low confidence in this ranking
          </p>
          <p className="mt-[4px] text-sh-text-2">AI-613 could not rank today’s list with confidence. The list below is in time order until you review the ranking.</p>
          <Pill variant="card" size="sm" icon={ChevronDown} className="mt-[8px] text-sh-text" onClick={onShowRanking}>
            Show the ranking
          </Pill>
        </div>
      )}

      {ordered.length === 0 ? (
        <p className="py-[12px] text-[14px] text-sh-text-2">
          Nothing needs you right now. A critical result, a rising risk score or a note awaiting your signature would appear here.
        </p>
      ) : (
        <ul className="-mx-[10px] flex flex-col gap-[3px]">
          {ordered.map((a) => (
            <AttentionRow
              key={a.id}
              item={a}
              onOpen={() => openQuickPanel(a)}
              onDictate={() => openNoteModal({ kind: 'patient', patientId: a.patientId, listening: true })}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function AttentionRow({ item, onOpen, onDictate }: { item: AttentionItem; onOpen: () => void; onDictate: () => void }) {
  const tone = URGENCY_TONE[item.urgency]
  const crit = tone === 'crit'
  const name = patient(item.patientId).name
  return (
    <li className={cn('flex items-center gap-[4px] rounded-[14px] pr-[4px]', crit && 'bg-(--attn-crit-row)')}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${item.urgency}: ${item.reason}, ${name}`}
        className={cn(
          'flex min-h-[44px] min-w-0 flex-1 items-center gap-[12px] rounded-[14px] px-[10px] py-[5px] text-left transition-colors duration-150',
          crit ? 'hover:bg-sh-crit-bg' : 'hover:bg-sh-hover',
        )}
      >
        <Shape tone={tone} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px]/[18px] font-medium text-sh-text">{item.reason}</span>
          <span className="block truncate text-[12px]/[16px] text-sh-text-3">{name}</span>
        </span>
        <Icon icon={ChevronRight} size={16} className="text-sh-chev" />
      </button>
      <RoundButton
        icon={Mic}
        size={44}
        variant="accent"
        label={`Add note about ${name}`}
        onClick={onDictate}
      />
    </li>
  )
}

/** §5.6 shapes — octagon (critical), triangle (warning), ring (pending). The word rides in the button's aria-label. */
function Shape({ tone }: { tone: Tone }) {
  if (tone === 'crit') {
    return (
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" className="shrink-0">
        <path d="M6.2 1h7.6L19 6.2v7.6L13.8 19H6.2L1 13.8V6.2z" fill="var(--crit)" stroke="var(--crit)" strokeWidth="1.2" strokeLinejoin="round" />
        <rect x="9" y="4.8" width="2" height="6.4" rx="1" fill="#fff" />
        <circle cx="10" cy="14.4" r="1.25" fill="#fff" />
      </svg>
    )
  }
  if (tone === 'warn') {
    return (
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" className="shrink-0">
        <path d="M10 2 18.6 17H1.4z" fill="var(--warn)" stroke="var(--warn)" strokeWidth="1.6" strokeLinejoin="round" />
        <rect x="9" y="7" width="2" height="5.4" rx="1" fill="#fff" />
        <circle cx="10" cy="15" r="1.2" fill="#fff" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" className="shrink-0">
      <circle cx="10" cy="10" r="7.4" fill="none" stroke="var(--pend-ring)" strokeWidth="2.8" />
    </svg>
  )
}

/* --------------------------------------------------------------- Tasks */

function Tasks({ items }: { items: FinishItem[] }) {
  const navigate = useNavigate()
  const total = items.reduce((n, r) => n + r.count, 0)
  return (
    <section aria-label="Tasks" className="min-w-0">
      <SectionLabel count={total} className="mb-[8px]">
        Tasks
      </SectionLabel>
      {items.length === 0 ? (
        <p className="py-[12px] text-[14px] text-sh-text-2">Nothing left to sign or write. A ward round note, a co-sign or a referral to review would appear here.</p>
      ) : (
        <ul className="-mx-[8px] flex flex-col gap-[3px]">
          {items.map((t) => {
            const urgent = t.urgency === 'critical' || t.urgency === 'warning'
            return (
              <li key={t.key}>
                <button
                  type="button"
                  onClick={() => navigate(canonical(t.to))}
                  className="flex min-h-[44px] w-full items-center gap-[12px] rounded-[14px] px-[8px] py-[4px] text-left transition-colors duration-150 hover:bg-sh-hover"
                >
                  <span className={cn('inline-flex size-[32px] shrink-0 items-center justify-center rounded-[10px]', t.icon === 'Mic' ? 'bg-sh-accent text-sh-accent-ink' : 'bg-sh-inner text-sh-text')}>
                    <Icon icon={iconFor(t.icon)} size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px]/[18px] font-medium text-sh-text">{t.label}</span>
                    {t.detail && <span className={cn('block truncate text-[12px]/[16px]', urgent ? 'text-sh-warn-fg' : 'text-sh-text-3')}>{t.detail}</span>}
                  </span>
                  <PillTag tone={urgent && t.urgency ? URGENCY_TONE[t.urgency] : 'neu'} size="xs" className="min-w-[24px] px-[7px] text-[12px] font-semibold tabular-nums">
                    {t.count}
                  </PillTag>
                  <Icon icon={ChevronRight} size={16} className="text-sh-chev" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
