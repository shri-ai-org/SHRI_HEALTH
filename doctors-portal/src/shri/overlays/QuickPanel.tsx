/**
 * §6.1 — the Quick-Panel, on the old build's data (`src/screens/m06/myday/
 * QuickPanel.tsx`): everything My Day leaves off the home screen, for one
 * attention item picked from Attention, the Critical KPI or the demo critical
 * event. Its question is WHAT CHANGED SINCE I LAST SAW THEM — a ward round is
 * a diff, not a re-read of the chart (`deltasFor` from the last-seen mark).
 * A 440px drawer on the right, over the scrim the shell owns; a bottom sheet
 * on a phone.
 *
 * The old build's rules, unchanged:
 *   a clinical value carries an icon and a word, never a colour alone;
 *   an AI finding carries its band, and one that cannot score says so;
 *   a patient nobody holds a care relationship with is sealed — no patient
 *   data and no actions — until break-glass, which is written before the
 *   record opens (GP-11);
 *   marking seen writes an audit row, and offline it queues and says so.
 */

import { AnimatePresence, motion } from 'framer-motion'
import {
  Aperture, BookOpen, Brain, Check, ChevronDown, CircleHelp, Eye, FlaskConical, Lock, LockOpen, Mic, Phone, ScrollText, ShieldCheck, TriangleAlert, WifiOff,
  X, type LucideIcon,
} from 'lucide-react'
import { useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { RESULT_TRENDS, RESULTS, RISK_STRIPS } from '@/data/clinical'
import { NOW, formatDateTime, formatElapsed, formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { cardFor, deltasFor, derivedLastSeen, lastNoteFor, type AttentionItem, type Delta } from '@/data/myday'
import { auditLabel, useAudit, type AuditRow } from '@/store/audit'
import { useClinical } from '@/store/clinical'
import { useCurrentStaff, useSession } from '@/store/session'
import { useUI } from '@/store/ui'

import { canonical } from '../app/paths'
import { cn } from '../lib/cn'
import { EASE } from '../lib/motion'
import { recordLinksFor, type RecordLinkKey } from '../logic/recordLinks'
import type { Tone } from '../mocks/types'
import { useAiActive, useForcedState } from '../state/ai'
import { useShri } from '../state/store'
import { TextArea } from '../ui/forms'
import { useDrawerFrame } from '../ui/frames'
import { useFocusTrap } from '../ui/hooks'
import { iconFor } from '../ui/icons'
import { Avatar, ConfidenceMark, Diamond, Icon, Pill, PillTag, RoundButton, SectionLabel, ToneDot } from '../ui/primitives'
import { Sparkline } from '../ui/Sparkline'

export function QuickPanel() {
  const item = useShri((s) => s.quickPanel)
  return <AnimatePresence>{item && <Panel key={item.id} item={item} />}</AnimatePresence>
}

/* ------------------------------------------------------------------ data */

const URGENCY_TONE: Record<AttentionItem['urgency'], Tone> = { critical: 'crit', warning: 'warn', pending: 'pend' }
const DOOR_ICON: Record<RecordLinkKey, LucideIcon> = { record: BookOpen, results: FlaskConical, reports: ScrollText, imaging: Aperture, stroke: Brain }

/** The old panel's initials: titles dropped, first letters, two at most. */
const initialsOf = (name: string) =>
  name
    .replace(/^(Dr\.?|Sr\.?|Mr|Ms)\s+/, '')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)

/** The trend behind a delta, where the record holds one. */
function trendFor(patientId: string, delta: Delta) {
  const result = RESULTS.find((r) => r.patientId === patientId && delta.label.startsWith(r.test))
  if (!result) return undefined
  const series = RESULT_TRENDS[result.id]
  if (!series || series.length < 2) return undefined
  return { series, unit: result.unit, label: result.test }
}

/** Across a day boundary the bare HH:MM would read as this morning. */
const when = (d: Date) => (d.toDateString() === NOW.toDateString() ? formatTime(d) : formatDateTime(d))

/* ----------------------------------------------------------------- panel */

function Panel({ item: it }: { item: AttentionItem }) {
  const navigate = useNavigate()
  const me = useCurrentStaff()
  const aiActive = useAiActive()
  const offline = useForcedState() === 'OFFLINE'
  const ref = useFocusTrap<HTMLElement>(true)
  const frame = useDrawerFrame(440)
  const close = useShri((s) => s.closeQuickPanel)
  const openNoteModal = useShri((s) => s.openNoteModal)
  const toast = useUI((s) => s.toast)
  const openExplain = useUI((s) => s.openExplain)

  const seenAt = useClinical((s) => s.seenAt)
  const pendingSeen = useClinical((s) => s.pendingSeen)
  const markSeen = useClinical((s) => s.markSeen)
  const voiceNotes = useClinical((s) => s.voiceNotes)
  const grantBreakGlass = useSession((s) => s.grantBreakGlass)
  const breakGlassPatients = useSession((s) => s.breakGlassPatients)
  const record = useAudit((s) => s.record)
  const auditRows = useAudit((s) => s.rows)

  const p = patient(it.patientId)
  const queued = pendingSeen.includes(it.patientId)
  // A patient nobody holds a care relationship with is sealed until break-glass — the case GP-11 exists for.
  const noRelationship = p.consultant === undefined
  const broken = breakGlassPatients[it.patientId]
  const sealed = noRelationship && !broken

  const lastSeen = seenAt[it.patientId] ? new Date(seenAt[it.patientId]) : derivedLastSeen(it.patientId)
  const deltas = sealed ? [] : deltasFor(it.patientId, lastSeen)
  const card = sealed ? null : cardFor(it.patientId, lastSeen, it.urgency)
  const charted = sealed ? undefined : lastNoteFor(it.patientId)
  /** A note dictated in this session is the last thing written, once it is newer than the charted one. */
  const dictated = sealed ? [] : (voiceNotes[it.patientId] ?? []).slice().sort((a, b) => b.at.localeCompare(a.at))
  const latest = dictated[0]
  const lastNote =
    latest && (!charted || new Date(latest.at) > charted.at)
      ? {
          label: latest.status === 'signed' ? 'Dictated note · signed' : 'Dictated note · draft',
          detail: latest.body,
          by: latest.by,
          initials: initialsOf(latest.by),
          at: new Date(latest.at),
        }
      : charted
  const risk = RISK_STRIPS[it.patientId]
  const subjectAudit = auditRows.filter((r) => r.subject === it.patientId).slice().reverse()
  const tone = URGENCY_TONE[it.urgency]
  const seen = seenAt[it.patientId] !== undefined

  function go(to: string) {
    close()
    navigate(canonical(to))
  }

  function doMarkSeen() {
    markSeen(it.patientId, NOW.toISOString(), offline)
    record({
      event: 'PATIENT.MARKED_SEEN',
      actor: me.name,
      actorId: me.id,
      subject: it.patientId,
      at: NOW.toISOString(),
      detail: offline ? 'Queued — device offline' : `${deltas.length} changes cleared`,
      queued: offline,
    })
    toast(
      offline
        ? { tone: 'caution', title: 'Queued — you are offline', detail: `${p.name} will sync when the connection returns. Nothing is lost.` }
        : { tone: 'success', title: 'Marked seen', detail: `${p.name} · changes cleared` },
    )
  }

  function breakGlass(reason: string) {
    grantBreakGlass(it.patientId, reason)
    record({ event: 'ACCESS.BREAK_GLASS', actor: me.name, actorId: me.id, subject: it.patientId, detail: reason })
    toast({ tone: 'caution', title: 'Break-glass recorded', detail: 'This access is logged and reviewed within 24 hours.' })
  }

  const why = () =>
    openExplain({
      touchpointId: `quick-${it.id}`,
      capabilityId: it.ai!,
      claim: it.detail,
      confidence: it.band === 'HIGH' ? 0.9 : it.band === 'MED' ? 0.72 : 0.4,
      band: it.band ?? 'LOW',
      computedAt: formatTime(it.since),
      inputs:
        risk && risk.band !== 'ABSTAIN'
          ? risk.drivers.map((d) => ({ label: d.label, source: 'Flowsheet, most recent set' }))
          : [{ label: 'Record entries since your last visit', source: `${p.uhid} timeline` }],
      drivers: risk && risk.band !== 'ABSTAIN' ? risk.drivers : undefined,
      model: risk?.modelVersion ?? `${it.ai} (mockup)`,
      limits: [
        'Derived from charted data only — anything not written down is invisible to it.',
        'Abstains rather than scoring where the inputs are too old.',
        'It ranks what needs attention; it does not decide what to do.',
      ],
    })

  return (
    <motion.aside
      ref={ref}
      role="dialog"
      aria-label={p.name}
      variants={frame.variants}
      initial="hidden"
      animate="shown"
      exit="exit"
      style={frame.style}
      className={cn(frame.className, 'z-50 flex flex-col bg-sh-card text-sh-text')}
    >
      {/* ---------------------------------------------------------- header */}
      <header className="flex items-start gap-[14px] border-b border-sh-line px-[20px] py-[20px]">
        <Avatar initials={initialsOf(p.name)} variant="pend" size={48} />
        <div className="min-w-0 flex-1 pt-[2px]">
          <h2 className="truncate text-[19px]/[1.2] font-medium tracking-[-0.012em] text-sh-text" title={p.name}>
            {p.name}
          </h2>
          <p className="mt-[3px] truncate text-[12px] tabular-nums text-sh-text-3">
            {p.age}/{p.sex} · {card?.room ?? p.bed ?? '—'} · {p.uhid}
          </p>
          <PillTag tone={tone} size="sm" className="mt-[10px] max-w-full gap-[7px]" title={it.reason}>
            <ToneDot tone={tone} size={7} />
            <span className="truncate">{it.reason}</span>
          </PillTag>
        </div>
        <RoundButton icon={X} label="Close" size={38} className="mt-[5px]" onClick={close} />
      </header>

      {/* ------------------------------------------------------------ body */}
      {sealed ? (
        <SealedBody onConfirm={breakGlass} />
      ) : (
        <div className="sh-scrollbar flex min-h-0 flex-1 flex-col gap-[16px] overflow-y-auto px-[20px] pb-[20px] pt-[20px]">
          {broken && (
            <div role="status" className="-mx-[20px] -mt-[20px] flex items-start gap-[10px] bg-sh-warn-bg px-[20px] py-[11px] text-sh-warn-fg">
              <Icon icon={TriangleAlert} size={16} className="mt-[1px] shrink-0" />
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Break-glass access · logged and reviewed within 24 hours</p>
                <p className="mt-[1px] text-[12px]">&ldquo;{broken.reason}&rdquo;</p>
              </div>
            </div>
          )}

          {/* The cut-off, in one line. */}
          <p className="flex flex-wrap items-center gap-x-[8px] text-[13px] text-sh-text-2">
            <Icon icon={Eye} size={16} className="text-sh-text-3" />
            <span>
              You last saw {p.name.split(' ').at(-1)} at <span className="font-medium tabular-nums text-sh-text">{when(lastSeen)}</span>
            </span>
            <span>· {formatElapsed((NOW.getTime() - lastSeen.getTime()) / 60000)} ago</span>
          </p>

          {/* The rest of the record, one tap away — a door only where there is something behind it. */}
          <nav aria-label={`${p.name}’s record`} className="grid grid-cols-3 gap-[8px]">
            {recordLinksFor(p).map((l) => (
              <Tile key={l.key} icon={DOOR_ICON[l.key]} label={l.label} onClick={() => go(l.to)} />
            ))}
          </nav>

          {/* What changed since then. Three, by priority. */}
          <section>
            <SectionLabel className="mb-[8px]">Changed since then</SectionLabel>
            <div className="rounded-sh-inner bg-sh-inner px-[12px]">
              {deltas.length === 0 && (
                <p className="py-[12px] text-[13px] text-sh-text-2">
                  Nothing has changed since you last saw this patient. New observations, results or medication changes would appear here.
                </p>
              )}
              {deltas.slice(0, 3).map((d) => (
                <ChangeRow key={`${d.type}-${d.ts}`} d={d} trend={trendFor(it.patientId, d)} ai={Boolean(d.ai) && aiActive} />
              ))}
              {deltas.length > 3 && (
                <button
                  type="button"
                  onClick={() => go(`/patient/${p.uhid}/timeline`)}
                  className="flex h-[44px] w-full items-center border-t border-sh-line-strong text-[12px] font-medium text-sh-text-2 transition-colors duration-150 hover:text-sh-text"
                >
                  +{deltas.length - 3} more on the timeline
                  <span aria-hidden="true" className="ml-[4px]">
                    ›
                  </span>
                </button>
              )}
            </div>
          </section>

          {/* The AI finding behind the ranking, with its band and its Why. */}
          {it.ai && aiActive && (
            <div className="rounded-[14px] border border-(--flags-ring) px-[12px] py-[10px] text-[13px] text-sh-text">
              <p>
                <Diamond className="mr-[6px]" />
                <span className="font-medium tabular-nums">{it.ai}</span>
                <span className="text-sh-text-2"> · {it.detail}</span>
              </p>
              <div className="mt-[6px] flex flex-wrap items-center justify-between gap-[8px]">
                {it.band ? (
                  <ConfidenceMark band={it.band} />
                ) : (
                  // A capability that cannot score shows ABSTAIN, not LOW.
                  <span className="inline-flex items-center gap-[5px] font-medium text-sh-warn-fg">
                    <Icon icon={CircleHelp} size={13} />
                    Cannot assess — no score, not a zero
                  </span>
                )}
                <button
                  type="button"
                  onClick={why}
                  className="inline-flex min-h-[32px] items-center text-[12px] font-medium text-sh-text-2 underline underline-offset-2 transition-colors duration-150 hover:text-sh-text"
                >
                  Why?
                </button>
              </div>
            </div>
          )}

          {/* The last thing written on this record. */}
          {lastNote && (
            <section>
              <SectionLabel
                className="mb-[8px]"
                right={
                  dictated.length > 0 && (
                    <button
                      type="button"
                      onClick={() => go(`/patient/${p.uhid}/notes`)}
                      className="inline-flex min-h-[32px] items-center gap-[4px] text-[12px] font-medium text-sh-text-2 transition-colors duration-150 hover:text-sh-text"
                    >
                      {dictated.length} dictated <span aria-hidden="true">›</span>
                    </button>
                  )
                }
              >
                Last note
              </SectionLabel>
              <div className="flex gap-[12px]">
                {lastNote.by.startsWith('AI-') ? (
                  <span className="inline-flex size-[32px] shrink-0 items-center justify-center rounded-full bg-sh-inner" title={lastNote.by}>
                    <Diamond />
                  </span>
                ) : (
                  <Avatar initials={lastNote.initials} variant="primary" size={32} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-sh-text-3">{lastNote.label}</p>
                  <p className="sh-clamp-2 mt-[2px] text-[14px]/[1.45] text-sh-text">{lastNote.detail}</p>
                  <p className="mt-[3px] text-[12px] tabular-nums text-sh-text-3">
                    {lastNote.by} · {formatTime(lastNote.at)}
                  </p>
                </div>
              </div>
            </section>
          )}

          <Audit rows={subjectAudit} />
        </div>
      )}

      {/* ---------------------------------------------------------- footer */}
      {!sealed && card && (
        <footer className="border-t border-sh-line px-[20px] py-[16px]">
          {queued && (
            <p className="mb-[10px] flex items-center gap-[8px] text-[12px] font-medium text-sh-warn-fg">
              <Icon icon={WifiOff} size={14} />1 mark-seen queued for sync
            </p>
          )}
          {/* Under 400px "Open record" and "Mark seen" need the whole row, so call and note drop beneath them. */}
          <div className="grid grid-cols-[1fr_1fr_48px_48px] gap-[8px] max-[400px]:grid-cols-2">
            {/* Enter on open goes to the record — the panel's primary action, not its close button. */}
            <Pill variant="primary" size="bar" data-autofocus="true" onClick={() => go(card.quick_actions.openChart)}>
              Open record
            </Pill>
            {seen && !offline ? (
              <Pill
                size="bar"
                icon={Check}
                disabled
                className="bg-sh-norm-bg text-sh-norm-fg hover:bg-sh-norm-bg disabled:cursor-default"
                title={`Seen at ${formatTime(new Date(seenAt[it.patientId]))}`}
              >
                Seen
              </Pill>
            ) : (
              // Offline the mark queues, so it can be made again; the old panel kept it live.
              <Pill variant="accent" size="bar" icon={seen ? Check : undefined} onClick={doMarkSeen}>
                {seen ? 'Seen' : 'Mark seen'}
              </Pill>
            )}
            <a
              href={card.quick_actions.callNurse}
              aria-label="Call nurse"
              title="Call nurse"
              className="inline-flex size-[48px] items-center justify-center rounded-full bg-sh-control text-sh-text transition-colors duration-150 hover:bg-sh-hover-strong max-[400px]:justify-self-center"
            >
              <Icon icon={Phone} size={18} />
            </a>
            <RoundButton
              icon={Mic}
              label="Add note"
              size={48}
              variant="accent"
              onClick={() => openNoteModal({ kind: 'patient', patientId: it.patientId, listening: true })}
              className="max-[400px]:justify-self-center"
            />
          </div>
        </footer>
      )}
    </motion.aside>
  )
}

/* ---------------------------------------------------------------- sealed */

/** GP-11 — offered, not refused. No patient data renders behind it, and nothing else can be done until it is recorded. */
function SealedBody({ onConfirm }: { onConfirm: (reason: string) => void }) {
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  const ok = reason.trim().length >= 8
  return (
    <div className="sh-scrollbar flex min-h-0 flex-1 flex-col gap-[12px] overflow-y-auto px-[20px] pb-[20px] pt-[20px]">
      <div className="rounded-sh-inner bg-sh-inner px-[14px] py-[14px]">
        <div className="flex items-center gap-[12px]">
          <span className="inline-flex size-[38px] shrink-0 items-center justify-center rounded-full bg-sh-card text-sh-text">
            <Icon icon={Lock} size={17} />
          </span>
          <span className="text-[14px] font-medium text-sh-text">No care relationship</span>
        </div>
        <p className="mt-[10px] text-[13px]/[1.5] text-sh-text-2">
          You hold the capability to read this record but you are not on this patient&rsquo;s care team. You can proceed with break-glass. The access is
          written before the record opens, and reviewed within 24 hours.
        </p>
      </div>
      {asking ? (
        <>
          <label htmlFor="bg-reason" className="text-[13px] font-medium text-sh-text-2">
            Why do you need this record?
          </label>
          <TextArea
            id="bg-reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Stated in your own words — this is read by the reviewer, not a dropdown."
            data-autofocus="true"
          />
          <div className="flex flex-wrap gap-[8px]">
            <Pill variant="crit" size="lg" icon={ShieldCheck} disabled={!ok} className="disabled:opacity-40" onClick={() => onConfirm(reason.trim())}>
              Record and open
            </Pill>
            <Pill variant="control" size="lg" onClick={() => setAsking(false)}>
              Cancel
            </Pill>
          </div>
        </>
      ) : (
        <Pill variant="crit" size="lg" icon={LockOpen} className="w-full" data-autofocus="true" onClick={() => setAsking(true)}>
          Break glass
        </Pill>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- parts */

function Tile({ icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <motion.button
      type="button"
      whileHover={{ y: -2 }}
      transition={{ duration: 0.2, ease: EASE }}
      onClick={onClick}
      className="flex h-[64px] flex-col items-center justify-center gap-[5px] rounded-sh-inner bg-sh-inner px-[6px] text-sh-text transition-[background-color,box-shadow] duration-200 hover:bg-sh-hover-strong hover:shadow-[0_6px_16px_rgba(18,20,26,0.08)]"
    >
      <Icon icon={icon} size={18} />
      <span className="sh-clamp-2 text-center text-[12px]/[14px] font-medium">{label}</span>
    </motion.button>
  )
}

/** One change: its icon and word, its value or trend, when. */
function ChangeRow({ d, trend, ai }: { d: Delta; trend?: ReturnType<typeof trendFor>; ai: boolean }) {
  return (
    <div className="flex items-start gap-[10px] border-t border-sh-line-strong py-[10px] first:border-t-0">
      <span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-[8px] bg-white text-sh-text shadow-[0_1px_2px_rgba(18,20,26,0.05)] shdark:bg-sh-card">
        <Icon icon={iconFor(d.icon)} size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex min-h-[30px] flex-wrap items-center gap-x-[10px] gap-y-[4px]">
          {/* The label wraps rather than truncating: the value it names is the point of the row. */}
          <span className="min-w-[140px] flex-1 text-[13px] font-medium text-sh-text">
            {d.label}
            {ai && <Diamond className="ml-[6px]" />}
          </span>
          {trend ? (
            <Sparkline points={trend.series} unit={trend.unit} label={trend.label} />
          ) : (
            d.value && <span className="shrink-0 text-[14px] font-semibold tabular-nums text-sh-text">{d.value}</span>
          )}
        </p>
        {d.detail && <p className="mt-[2px] text-[12px] text-sh-text-2">{d.detail}</p>}
        <p className="mt-[2px] text-[12px] tabular-nums text-sh-text-3">{when(new Date(d.ts))}</p>
      </div>
    </div>
  )
}

/** The trail, visible. A log nobody can read is not a control. */
function Audit({ rows }: { rows: AuditRow[] }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="-mx-[10px] flex h-[44px] w-[calc(100%+20px)] items-center gap-[8px] rounded-[12px] px-[10px] text-[13px] font-medium text-sh-text transition-colors duration-150 hover:bg-sh-hover"
      >
        <Icon icon={ShieldCheck} size={16} className="text-sh-text-3" />
        <span>
          Audit — {rows.length} {rows.length === 1 ? 'event' : 'events'}
        </span>
        <Icon icon={ChevronDown} size={16} className={cn('ml-auto text-sh-chev transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open && (
        <ul id={listId} className="flex max-h-[160px] flex-col gap-[6px] overflow-y-auto pb-[4px] pl-[24px] pt-[4px]">
          {rows.length === 0 && <li className="text-[12px] text-sh-text-2">Nothing recorded against this patient in this session yet.</li>}
          {rows.map((r) => (
            <li key={r.id} className="text-[12px] text-sh-text-2">
              <span className="tabular-nums text-sh-text-3">{formatTime(new Date(r.at))}</span> <span className="font-medium text-sh-text">{auditLabel(r.event)}</span>{' '}
              <span>
                · {r.actor}
                {r.model ? ` · ${r.model}` : ''}
                {r.gate ? ` · ${r.gate}` : ''}
                {r.queued ? ' · queued' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
