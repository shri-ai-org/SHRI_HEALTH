/**
 * VoiceField — a text box that is typed into always and spoken into on one
 * press, in this build's look, with the old build's behaviour
 * (`src/components/voicefield.tsx`; as `layout="note"`, the box of its My Day
 * `DictationPanel`, `src/components/dictation.tsx:644-906`).
 *
 *   · The box opens empty. Nothing is pre-filled, ever.
 *   · It is a chat bar: always typable, the microphone inside it. Pressing the
 *     mic raises the browser's own permission prompt and listens; the words
 *     are written INTO THE BOX as they are spoken, after whatever was already
 *     there, which is kept. Stop ends it; the text is then plain text again.
 *   · One microphone at a time (`useVoiceArbiter`): while another box listens,
 *     this one's mic says so.
 *   · Under dictated text sits one quiet provenance line: ◆ dictated · live ·
 *     confidence · Why?.
 *   · Where the browser cannot listen, the box says why in one line and stays
 *     typeable. There is no canned text standing in for speech.
 *
 * The two layouts keep the two old rules that differ:
 *   field — a form's free text. The mic is an AI-101 affordance, so with AI
 *           off it is HIDDEN, not greyed; AI-104 offers to tidy the text, with
 *           Undo; a new take joins the old text as a new sentence.
 *   note  — the My Day note. Its mic stays with AI off (the old panel's), it is
 *           absent where the browser cannot listen at all, and it offers no
 *           tidy-up; a new take continues the text.
 */

import { Loader, Mic, MicOff, PenLine, Square } from 'lucide-react'
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'

import type { ConfidenceBand } from '@/atlas/confidence'
import { tidyText } from '@/data/abbreviations'
import { formatClock } from '@/data/format'
import { LANGUAGES } from '@/data/kit'
import { joinSpeech } from '@/data/scribe'
import { useAI } from '@/store/ai'
import { useCurrentStaff, useSession } from '@/store/session'
import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import { dictationWhy, useDictation, useVoiceArbiter, type DictationPhase, type DictationRun } from '../logic/dictation'
import { useAiActive } from '../state/ai'

import { TextArea } from './forms'
import { ConfidenceMark, Diamond, Icon, Pill, RoundButton } from './primitives'

export interface DictatedMeta {
  /** The box's value after the words landed. */
  text: string
  model: string
  band: ConfidenceBand
  confidence: number
  /** False where the recogniser gave no score — show the band, not a percentage. */
  scored: boolean
  words: number
}

/** What an owner can do to the box it holds — Save stops a take in progress first. */
export interface VoiceFieldHandle {
  stop: () => void
}

/** A form's new take starts a new sentence (`voicefield.tsx` `append`). */
function asSentence(existing: string, spoken: string): string {
  const a = existing.trim()
  const b = spoken.trim()
  if (!a) return b
  if (!b) return a
  return `${a}${/[.!?]$/.test(a) ? '' : '.'} ${b}`
}

export function VoiceField({
  id,
  label,
  layout = 'field',
  required,
  value,
  onChange,
  onDictated,
  rows = 5,
  placeholder,
  typedPlaceholder,
  disabled,
  hint,
  autoStart,
  autoFocus,
  onPhase,
  onBlur,
  className,
  boxClassName,
  labelExtra,
  tidy = true,
  handle,
}: {
  id: string
  /** The field's name — its visible label, or (layout `note`) the box's accessible name. */
  label: string
  layout?: 'field' | 'note'
  required?: boolean
  value: string
  /** Every change; `source` is `'dictation'` while words are being written in from the microphone. */
  onChange: (v: string, source?: 'dictation') => void
  /** Once per recording, on Stop, after the words have landed in the box. */
  onDictated?: (meta: DictatedMeta) => void
  rows?: number
  placeholder?: string
  /** The placeholder when there is no microphone to press. */
  typedPlaceholder?: string
  disabled?: boolean
  hint?: ReactNode
  /** Opened from a microphone: already listening. */
  autoStart?: boolean
  /** Opened to be typed into: the box takes focus. */
  autoFocus?: boolean
  /** Told whenever the take's phase changes — an owner's Save waits while the permission prompt is up. */
  onPhase?: (phase: DictationPhase) => void
  /** Leaving the field — where a form checks what was written (validation on blur, never on keystroke). */
  onBlur?: () => void
  className?: string
  boxClassName?: string
  labelExtra?: ReactNode
  /** AI-104 tidy-up under a field with text (layout `field` only). */
  tidy?: boolean
  handle?: Ref<VoiceFieldHandle>
}) {
  const note = layout === 'note'
  const aiActive = useAiActive()
  const recordDisposition = useAI((s) => s.record)
  const openExplain = useUI((s) => s.openExplain)
  const me = useCurrentStaff()
  const language = useSession((s) => s.language)
  const activeId = useVoiceArbiter((s) => s.activeId)

  /** What was in the box when recording started. Non-null exactly while a take is open. */
  const base = useRef<string | null>(null)
  const valueRef = useRef(value)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const [dictatedMeta, setDictatedMeta] = useState<DictatedMeta | null>(null)
  /** The doctor's own change since the last take landed. */
  const [edited, setEdited] = useState(false)
  /** What the text was before Tidy up, so Undo is exact. */
  const [beforeTidy, setBeforeTidy] = useState<{ was: string; changes: string[] } | null>(null)
  const join = note ? joinSpeech : asSentence

  /** The take closes exactly once: the final words land, and `onDictated` hears about it. */
  function land(run: DictationRun) {
    const was = base.current
    base.current = null
    if (was === null) return
    const spoken = run.text.trim()
    if (spoken !== '') {
      const text = join(was, spoken)
      onChange(text, 'dictation')
      const meta: DictatedMeta = { text, model: run.model, band: run.band, confidence: run.confidence, scored: run.scored, words: spoken.split(/\s+/).length }
      setDictatedMeta(meta)
      setEdited(false)
      onDictated?.(meta)
    } else if (valueRef.current !== was) {
      // Nothing was heard: the box goes back to exactly what it held.
      onChange(was)
    }
    window.setTimeout(() => boxRef.current?.focus(), 0)
  }

  const d = useDictation({ arbiterId: id, onEnd: land })
  useImperativeHandle(handle, () => ({ stop: d.stop }), [d.stop])

  useEffect(() => {
    valueRef.current = value
  })

  const recording = d.phase === 'recording'
  const requesting = d.phase === 'requesting'
  const listening = recording || requesting
  const onPhaseRef = useRef(onPhase)
  onPhaseRef.current = onPhase
  useEffect(() => onPhaseRef.current?.(d.phase), [d.phase])

  /** The words go INTO the box as they are spoken, after what was already there. */
  const liveSpoken = recording ? joinSpeech(d.settled, d.interim) : ''
  useEffect(() => {
    if (!recording || base.current === null || liveSpoken === '') return
    const next = join(base.current, liveSpoken)
    if (next !== valueRef.current) onChange(next, 'dictation')
    // `onChange` and `join` are stable in meaning; the words are what drive this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, liveSpoken])

  function start() {
    base.current = value
    setBeforeTidy(null)
    d.start()
  }

  // Opened from a microphone, it is already listening; opened from a plus, the box is ready to type.
  const startRef = useRef(start)
  startRef.current = start
  useEffect(() => {
    if (autoStart && d.supportNotice === null) startRef.current()
    else if (autoFocus) window.setTimeout(() => boxRef.current?.focus(), 0)
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A form's mic is an AI-101 affordance: absent with AI off. The note's is absent only where the browser cannot listen.
  const hasMic = !disabled && (note ? d.supportNotice === null : aiActive)
  const someoneElse = activeId !== null && activeId !== id
  const hasText = value.trim() !== ''
  const tidied = useMemo(() => tidyText(value), [value])
  const canTidy = !note && tidy && aiActive && !disabled && !listening && hasText && tidied.text !== value
  const notice = note ? (d.notice ?? d.supportNotice) : d.notice
  const micLabel = note ? (dictatedMeta ? 'Dictate more' : 'Dictate') : `Dictate into ${label.toLowerCase()}`
  const langLabel = LANGUAGES.find((l) => l.code === language)?.label

  const why = (meta: DictatedMeta) =>
    openExplain(
      dictationWhy({
        touchpointId: `dictation-${id}`,
        model: meta.model,
        band: meta.band,
        confidence: meta.confidence,
        language,
        commits: note ? 'save' : 'sign',
      }),
    )

  const box = (
    <TextArea
      id={id}
      ref={boxRef}
      rows={rows}
      value={value}
      disabled={disabled}
      readOnly={recording}
      aria-busy={recording}
      aria-label={note ? label : undefined}
      data-autofocus={autoFocus ? 'true' : undefined}
      aria-describedby={hint ? `${id}-hint` : undefined}
      onChange={(e) => {
        setEdited(true)
        onChange(e.target.value)
      }}
      placeholder={
        recording ? 'Listening…' : hasMic ? (placeholder ?? `Type the ${label.toLowerCase()}, or press the microphone…`) : (typedPlaceholder ?? `Type the ${label.toLowerCase()}…`)
      }
      className={cn(
        hasMic && (note ? 'pb-[58px]' : 'pr-[52px]'),
        note && 'min-h-0 resize-none rounded-[18px] border border-sh-line bg-(--note-box-bg) hover:bg-(--note-box-bg)',
        recording && 'inset-ring-2 inset-ring-sh-accent',
        boxClassName,
      )}
    />
  )

  return (
    <div className={cn('min-w-0', className)} onBlur={onBlur}>
      {!note && (
        <div className="mb-[6px] flex flex-wrap items-center justify-between gap-[8px]">
          <label htmlFor={id} className="flex items-center gap-[6px] text-[13px] font-medium text-sh-text-2">
            {label}
            {required && (
              <>
                <span className="text-sh-crit-fg" aria-hidden="true">
                  *
                </span>
                <span className="sr-only"> (required)</span>
              </>
            )}
            {labelExtra}
          </label>
        </div>
      )}

      {/* One box, the microphone inside it. */}
      <div className={cn('relative', note && 'flex min-h-0 flex-1 flex-col')}>
        {box}
        {hasMic &&
          (note ? (
            <div className="absolute bottom-[10px] left-[10px] right-[10px] flex items-center gap-[10px]">
              {listening ? (
                <Pill size="md" onClick={d.stop} className="bg-(--stop) text-white hover:bg-(--stop) hover:brightness-95" aria-label="Stop recording" title="Stop recording">
                  <Icon icon={Square} size={12} className="fill-current" />
                  Stop
                </Pill>
              ) : (
                <Pill variant="accent" size="md" icon={Mic} onClick={start}>
                  {micLabel}
                </Pill>
              )}
              {recording && <Listening d={d} label="Listening · live recognition" />}
            </div>
          ) : (
            <div className="absolute bottom-[8px] right-[8px]">
              {listening ? (
                <RoundButton icon={Square} size={36} iconSize={14} variant="primary" label="Stop recording" onClick={d.stop} />
              ) : (
                <RoundButton
                  icon={Mic}
                  size={36}
                  iconSize={16}
                  variant="control"
                  label={someoneElse ? 'Another field is listening' : micLabel}
                  aria-label={micLabel}
                  disabled={someoneElse}
                  onClick={start}
                />
              )}
            </div>
          ))}
      </div>

      {/* While it listens: the permission prompt, or (in a form) the levels and the clock. */}
      {requesting && <RequestingLine className="mt-[8px]" />}
      {recording && !note && (
        <div className="mt-[8px] flex flex-wrap items-center gap-x-[10px] gap-y-[4px]">
          <Listening d={d} label="Listening · live" />
        </div>
      )}
      {recording && note && (
        <p className="mt-[8px] truncate text-[12px] text-sh-text-3">
          {d.model} · {langLabel}
        </p>
      )}

      {/* Why the microphone could not be used, said plainly. The box above stays typeable. */}
      {notice && !recording && <DictationNotice className="mt-[10px]">{notice}</DictationNotice>}

      {/* One quiet provenance line under dictated text. */}
      {!listening && hasText && dictatedMeta && (
        <div className="mt-[8px] flex flex-wrap items-center gap-x-[10px] gap-y-[4px] text-[12px] text-sh-text-2">
          <span className="inline-flex min-w-0 items-center gap-[5px]">
            <Diamond />
            <span className="truncate">{note ? `Dictated · live · ${dictatedMeta.model}` : 'Dictated · live'}</span>
          </span>
          <ConfidenceMark band={dictatedMeta.band} />
          <button
            type="button"
            onClick={() => why(dictatedMeta)}
            className="inline-flex min-h-[32px] items-center font-semibold text-sh-text underline-offset-2 hover:underline"
          >
            Why?
          </button>
          {note && edited && (
            <span className="inline-flex items-center gap-[5px] font-medium text-sh-norm-fg">
              <Icon icon={PenLine} size={12} />
              edited by you
            </span>
          )}
        </div>
      )}

      {/* AI-104 — the same table that rejects a banned abbreviation offers to write it out. */}
      {!listening && (canTidy || beforeTidy) && (
        <div className="mt-[8px] flex flex-wrap items-center gap-x-[10px] gap-y-[4px] text-[12px]">
          {canTidy && (
            <Pill
              variant="inner"
              size="sm"
              title={tidied.changes.join(' · ')}
              onClick={() => {
                setBeforeTidy({ was: value, changes: tidied.changes })
                onChange(tidied.text)
                recordDisposition({ touchpointId: `tidy-${id}`, disposition: 'Accepted', by: me.name, modelVersion: 'AI-104 tidy v1.0', confidence: 'HIGH' })
              }}
            >
              <Diamond />
              Tidy up with AI
              <span className="text-sh-text-3">
                · {tidied.changes.length} {tidied.changes.length === 1 ? 'change' : 'changes'}
              </span>
            </Pill>
          )}
          {beforeTidy && !canTidy && (
            <>
              <span className="inline-flex items-center gap-[5px] text-sh-text-2">
                <Diamond />
                Tidied · {beforeTidy.changes.join(', ')}
              </span>
              <button
                type="button"
                onClick={() => {
                  onChange(beforeTidy.was)
                  setBeforeTidy(null)
                }}
                className="inline-flex min-h-[32px] items-center font-semibold text-sh-text-2 underline decoration-dotted underline-offset-2 hover:text-sh-text"
              >
                Undo
              </button>
            </>
          )}
        </div>
      )}

      {hint && (
        <p id={`${id}-hint`} className="mt-[6px] text-[12px]/[1.4] text-sh-text-3">
          {hint}
        </p>
      )}
    </div>
  )
}

/** The levels off the microphone, the clock, and what is listening. */
function Listening({ d, label }: { d: ReturnType<typeof useDictation>; label: string }) {
  return (
    <>
      <span className="flex h-[18px] items-center gap-[3px]" aria-hidden="true">
        {d.bars.slice(-12).map((b, i) => (
          <span key={i} className="w-[3px] rounded-full bg-sh-accent transition-[height] duration-100" style={{ height: `${Math.max(4, Math.round(b * 18))}px` }} />
        ))}
      </span>
      <span className="text-[12px] tabular-nums text-sh-text-2">{formatClock(d.elapsedSec)}</span>
      <span className="inline-flex min-w-0 items-center gap-[5px] truncate text-[12px] text-sh-text-2">
        <Diamond />
        {label}
      </span>
    </>
  )
}

/** The one line shown while the browser's own permission prompt is up. */
function RequestingLine({ className }: { className?: string }) {
  return (
    <p role="status" className={cn('flex items-center gap-[8px] text-[13px] text-sh-text-2', className)}>
      <Icon icon={Loader} size={14} className="shrink-0 animate-spin motion-reduce:animate-none" />
      Allow microphone access in your browser’s prompt…
    </p>
  )
}

/** Why recognition could not run, and what to do about it. */
function DictationNotice({ children, className }: { children: string; className?: string }) {
  return (
    <p role="status" className={cn('flex items-start gap-[8px] rounded-[14px] bg-sh-warn-bg px-[12px] py-[10px] text-[13px] text-sh-warn-fg', className)}>
      <Icon icon={MicOff} size={14} className="mt-[2px] shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  )
}
