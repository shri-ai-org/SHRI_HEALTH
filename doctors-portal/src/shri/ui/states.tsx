// ported from src/components/states.tsx:104-151 (`ErrorFrame`), 293-357
// (`OfflineStrip`, `StaleChip`) and 412-419 (`AiOffLine`), with the values the
// old frame gave them (`src/shell/Screen.tsx:209-229`): the screen states that
// annotate or replace a screen, in the old build's words. Every one is reached
// through `useAI.forceState` (DEV `?state=` / `window.__forceState`).

import { CircleAlert, CircleDot, Clock, Copy, Lock, Minus, PenLine, RefreshCw, WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'

import { NOW, formatTime } from '@/data/format'
import { useClinical } from '@/store/clinical'

import { cn } from '../lib/cn'
import { forceState } from '../state/ai'

import { Alert } from './Alert'
import { Card, Icon, Pill } from './primitives'

/** What the old frame said still works, queues and is blocked while offline — the same on every screen. */
const OFFLINE = {
  works: ['Reading the record', 'Typing and drafting', 'Static protocols'],
  queued: ['Sign', 'Order placement', 'ABDM publish'],
  blocked: ['Live bed state', 'New imaging'],
}

/**
 * C-37 — "What still works, what is queued, what is blocked. TYPED CONTENT IS
 * NEVER LOST." The count is the real queue (the old frame printed a fixed 3).
 */
export function OfflineStrip({ className }: { className?: string }) {
  const pending = useClinical((s) => s.pendingSeen.length)
  return (
    <div role="status" className={cn('rounded-[18px] bg-sh-inner px-[16px] py-[10px]', className)}>
      <p className="flex flex-wrap items-center gap-x-[14px] gap-y-[2px]">
        <span className="flex items-center gap-[8px] text-[13px] font-semibold text-sh-text">
          <Icon icon={WifiOff} size={15} strokeWidth={2} />
          Offline
        </span>
        <span className="text-[13px] tabular-nums text-sh-text-2">{pending} changes waiting to sync</span>
      </p>
      <dl className="mt-[6px] grid gap-x-[24px] gap-y-[4px] text-[12px] sm:grid-cols-3">
        <div>
          <dt className="font-semibold text-sh-norm-fg">Still works</dt>
          <dd className="text-sh-text-2">{OFFLINE.works.join(' · ')}</dd>
        </div>
        <div>
          <dt className="font-semibold text-sh-warn-fg">Queued</dt>
          <dd className="text-sh-text-2">{OFFLINE.queued.join(' · ')}</dd>
        </div>
        <div>
          <dt className="font-semibold text-sh-crit-fg">Blocked</dt>
          <dd className="text-sh-text-2">{OFFLINE.blocked.length ? OFFLINE.blocked.join(' · ') : 'nothing'}</dd>
        </div>
      </dl>
    </div>
  )
}

/** "Timestamp turns amber, 'Data as of HH:MM · Refresh'." The old frame dated it 34 minutes back. */
export function StaleChip({ className }: { className?: string }) {
  const asOf = new Date(NOW.getTime() - 1000 * 60 * 34)
  return (
    <span className={cn('inline-flex h-[36px] items-center gap-[8px] rounded-full bg-sh-warn-bg px-[14px] text-[13px] font-medium text-sh-warn-fg', className)}>
      <Icon icon={Clock} size={14} strokeWidth={2} />
      <span className="tabular-nums">Data as of {formatTime(asOf)}</span>
      <button type="button" onClick={() => forceState(null)} className="inline-flex min-h-[32px] items-center font-semibold underline underline-offset-2">
        Refresh
      </button>
    </span>
  )
}

/**
 * AI-OFF — "one quiet line". The screen is fully usable and nothing is greyed
 * out, because greying advertises an absence the clinician cannot act on.
 */
export function AiOffLine({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-center gap-[8px] text-[13px] text-sh-text-2', className)}>
      <Icon icon={CircleDot} size={14} />
      AI assistance is off. Everything on this screen works; deterministic safety checks still run.
    </p>
  )
}

/** ERROR — "Recoverable, with the user's input PRESERVED and an escape hatch." The old frame's words for every screen. */
export function ErrorFrame({ className }: { className?: string }) {
  return (
    <Card className={className}>
      <div className="flex items-start gap-[14px]">
        <span className="inline-flex size-[44px] shrink-0 items-center justify-center rounded-full bg-sh-crit-bg text-sh-crit-fg">
          <Icon icon={CircleAlert} size={20} />
        </span>
        <div className="min-w-0">
          <h2 className="text-[19px]/[1.2] font-medium tracking-[-0.012em] text-sh-text">That did not save</h2>
          <p className="mt-[6px] text-[14px] text-sh-text-2">
            <strong className="font-semibold text-sh-text">Everything you typed is kept.</strong> Nothing you typed has been lost.
          </p>
          <div className="mt-[14px] flex flex-wrap gap-[8px]">
            <Pill variant="primary" size="lg" icon={RefreshCw} onClick={() => forceState(null)}>
              Try again
            </Pill>
            <Pill variant="control" size="lg" icon={Copy} onClick={() => forceState(null)}>
              Copy the text out
            </Pill>
          </div>
        </div>
      </div>
    </Card>
  )
}

/**
 * VALIDATION (`src/components/states.tsx:153-200`) — "count of problems, inline
 * errors, focus moved to the first, primary action STAYS DISABLED".
 */
export function ValidationSummary({ problems, onFocusFirst, className }: { problems: { field: string; message: string }[]; onFocusFirst?: () => void; className?: string }) {
  if (problems.length === 0) return null
  return (
    <Alert
      tone="crit"
      role="alert"
      className={className}
      title={`${problems.length} ${problems.length === 1 ? 'item needs' : 'items need'} attention`}
      action={
        onFocusFirst && (
          <Pill variant="card" size="md" onClick={onFocusFirst}>
            Go to the first
          </Pill>
        )
      }
    >
      <ul className="flex flex-col gap-[4px]">
        {problems.map((p, i) => (
          <li key={`${p.field}-${i}`} className="flex gap-[8px]">
            <Icon icon={Minus} size={13} className="mt-[4px] shrink-0" />
            <span>
              <strong className="font-semibold text-sh-text">{p.field}</strong> — {p.message}
            </span>
          </li>
        ))}
      </ul>
    </Alert>
  )
}

/**
 * LOCKED (`src/components/states.tsx:362-410`) — "read-only render naming WHO
 * HOLDS IT AND SINCE WHEN, plus the legitimate next action". On an authoring
 * screen that is CMP-NABH-10's Addendum — a signed record is never edited.
 */
export function LockedBanner({
  by,
  at,
  reason = 'signed',
  onAddendum,
  className,
}: {
  by: string
  at: string
  reason?: 'signed' | 'held' | 'closed'
  onAddendum?: () => void
  className?: string
}): ReactNode {
  const copy =
    reason === 'signed'
      ? `Signed by ${by} at ${at}. A signed record is never edited — add an addendum instead.`
      : reason === 'closed'
        ? `Closed by ${by} at ${at}. Corrections are audited amendments, never overwrites.`
        : `Held by ${by} since ${at}. It will release when they close it.`
  return (
    <Alert
      tone="info"
      icon={Lock}
      className={className}
      title="Read-only"
      action={
        onAddendum && (
          <Pill variant="primary" size="md" icon={PenLine} onClick={onAddendum}>
            Addendum
          </Pill>
        )
      }
    >
      {copy}
    </Alert>
  )
}
