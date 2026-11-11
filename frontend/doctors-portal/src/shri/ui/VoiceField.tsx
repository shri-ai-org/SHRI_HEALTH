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
 *
 * `typeAlong` (the video visit's notes): the box stays typeable while the mic
 * listens. The words still being heard show faintly under it, and each phrase
 * joins the end of the text once it is settled — so the doctor's own typing is
 * never written over.
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
import { STREAM_MODEL } from '../logic/asrStream'
import { dictationWhy, useVoiceArbiter, type DictationPhase, type DictationRun, type DictationState } from '../logic/dictation'
import { useVoiceEngine } from '../logic/voiceEngine'
import { useAiActive } from '../state/ai'

import { TextArea } from './forms'
import { useTypewriter } from '../logic/typewriter'
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
  typeAlong = false,
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
  /** Typeable while listening; settled phrases join the end of the text, the rest shows under the box. */
  typeAlong?: boolean
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

  /** typeAlong: how much of this take's settled words is already in the box. */
  const fed = useRef('')

  /** The take closes exactly once: the final words land, and `onDictated` hears about it. */
  function land(run: DictationRun) {
    const was = base.current
    base.current = null
    if (was === null) return
    if (typeAlong) {
      // What the doctor typed stays; only the words not yet in the box join its end.
      const spoken = run.text.trim()
      const rest = spoken.startsWith(fed.current) ? spoken.slice(fed.current.length).trim() : fed.current ? '' : spoken
      fed.current = ''
      const text = rest ? join(valueRef.current, rest) : valueRef.current
      if (rest) onChange(text, 'dictation')
      if (spoken) {
        const meta: DictatedMeta = { text, model: run.model, band: run.band, confidence: run.confidence, scored: run.scored, words: spoken.split(/\s+/).length }
        setDictatedMeta(meta)
        onDictated?.(meta)
      }
      return
    }
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

  const d = useVoiceEngine({ arbiterId: id, onEnd: land })
  /** Shri Health's own speech service: Tamil and English in, English out — and, by the brief, no AI labels on it. */
  const streaming = d.engine === 'stream'
  useImperativeHandle(handle, () => ({ stop: d.stop }), [d.stop])

  useEffect(() => {
    valueRef.current = value
  })

  const recording = d.phase === 'recording'
  const requesting = d.phase === 'requesting'
  /** After Stop, while the service settles the last words — the box waits for them. */
  const processing = d.phase === 'processing'
  const listening = recording || requesting || processing
  const onPhaseRef = useRef(onPhase)
  onPhaseRef.current = onPhase
  useEffect(() => onPhaseRef.current?.(d.phase), [d.phase])

  /** The words go INTO the box as they are spoken, after what was already there — typed in, from the service. */
  const liveSpoken = recording || processing ? joinSpeech(d.settled, d.interim) : ''
  const typed = useTypewriter(liveSpoken, streaming)
  // typeAlong: each settled phrase joins the end of whatever the box holds now.
  useEffect(() => {
    if (!typeAlong || !(recording || processing) || base.current === null) return
    const now = d.settled.trim()
    if (now.length <= fed.current.length || !now.startsWith(fed.current)) return
    const add = now.slice(fed.current.length).trim()
    fed.current = now
    if (add) onChange(join(valueRef.current, add), 'dictation')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeAlong, recording, processing, d.settled])
  useEffect(() => {
    if (typeAlong || !(recording || processing) || base.current === null || typed === '') return
    const next = join(base.current, typed)
    if (next !== valueRef.current) onChange(next, 'dictation')
    // `onChange` and `join` are stable in meaning; the words are what drive this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, processing, typed])

  function start() {
    base.current = value
    fed.current = ''
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
      readOnly={!typeAlong && (recording || processing)}
      aria-busy={recording || processing}
      aria-label={note ? label : undefined}
      data-autofocus={autoFocus ? 'true' : undefined}
      aria-describedby={hint ? `${id}-hint` : undefined}
      onChange={(e) => {
        setEdited(true)
        onChange(e.target.value)
      }}
      placeholder={
        recording ? 'Listening…' : processing ? 'Processing…' : hasMic ? (placeholder ?? `Type the ${label.toLowerCase()}, or press the microphone…`) : (typedPlaceholder ?? `Type the ${label.toLowerCase()}…`)
      }
      className={cn(
        hasMic && (note ? 'pb-[58px]' : 'pr-[52px]'),
        note && 'min-h-0 resize-none rounded-[18px] border border-sh-line bg-(--note-box-bg) hover:bg-(--note-box-bg)',
        (recording || processing) && 'inset-ring-2 inset-ring-sh-accent',
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
              {processing ? (
                <Processing />
              ) : listening ? (
                <RoundButton
                  icon={Square}
                  size={44}
                  iconSize={14}
                  label="Stop recording"
                  onClick={d.stop}
                  className={cn('bg-(--stop) text-white hover:bg-(--stop) hover:brightness-95 [&_svg]:fill-current', streaming && recording && 'motion-safe:animate-[sh-mic-glow_1.8s_ease-in-out_infinite]')}
                />
              ) : (
                <RoundButton icon={Mic} size={44} iconSize={19} variant="accent" label={micLabel} onClick={start} />
              )}
              {recording && <Listening d={d} label={streaming ? 'Listening…' : 'Listening · live recognition'} plain={streaming} />}
            </div>
          ) : (
            <div className="absolute bottom-[8px] right-[8px]">
              {processing ? (
                <RoundButton icon={Loader} size={36} iconSize={14} variant="control" label="Processing…" disabled onClick={() => undefined} className="[&_svg]:animate-spin motion-reduce:[&_svg]:animate-none" />
              ) : listening ? (
                <RoundButton
                  icon={Square}
                  size={36}
                  iconSize={14}
                  variant="primary"
                  label="Stop recording"
                  onClick={d.stop}
                  className={cn(streaming && recording && 'motion-safe:animate-[sh-mic-glow_1.8s_ease-in-out_infinite]')}
                />
              ) : (
                <RoundButton
                  icon={Mic}
                  size={36}
                  iconSize={16}
                  variant="accent"
                  label={someoneElse ? 'Another field is listening' : micLabel}
                  aria-label={micLabel}
                  disabled={someoneElse}
                  onClick={start}
                />
              )}
            </div>
          ))}
      </div>

      {/* typeAlong: the words still being heard, under the box until they settle into it. */}
      {typeAlong && recording && d.interim.trim() !== '' && (
        <p className="mt-[6px] text-[13px] italic text-sh-text-3" data-hearing="">
          Hearing: “{d.interim.trim()}”
        </p>
      )}

      {/* While it listens: the permission prompt, or (in a form) the levels and the clock. */}
      {requesting && <RequestingLine className="mt-[8px]" />}
      {recording && !note && (
        <div className="mt-[8px] flex flex-wrap items-center gap-x-[10px] gap-y-[4px]">
          <Listening d={d} label={streaming ? 'Listening…' : 'Listening · live'} plain={streaming} />
        </div>
      )}
      {processing && !note && <Processing className="mt-[8px]" />}
      {recording && note && !streaming && (
        <p className="mt-[8px] truncate text-[12px] text-sh-text-3">
          {d.model} · {langLabel}
        </p>
      )}
      {d.engineNotice && !listening && <p className="mt-[8px] text-[12px] text-sh-text-3">{d.engineNotice}</p>}

      {/* Why the microphone could not be used, said plainly. The box above stays typeable. */}
      {notice && !recording && <DictationNotice className="mt-[10px]">{notice}</DictationNotice>}

      {/* One quiet provenance line under dictated text. */}
      {!listening && hasText && dictatedMeta && dictatedMeta.model === STREAM_MODEL && note && edited && (
        <p className="mt-[8px] inline-flex items-center gap-[5px] text-[12px] font-medium text-sh-norm-fg">
          <Icon icon={PenLine} size={12} />
          edited by you
        </p>
      )}
      {!listening && hasText && dictatedMeta && dictatedMeta.model !== STREAM_MODEL && (
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
function Listening({ d, label, plain }: { d: DictationState; label: string; plain?: boolean }) {
  return (
    <>
      <span className="flex h-[18px] items-center gap-[3px]" aria-hidden="true">
        {d.bars.slice(-12).map((b, i) => (
          <span key={i} className="w-[3px] rounded-full bg-sh-accent transition-[height] duration-100" style={{ height: `${Math.max(4, Math.round(b * 18))}px` }} />
        ))}
      </span>
      <span className="text-[12px] tabular-nums text-sh-text-2">{formatClock(d.elapsedSec)}</span>
      <span className="inline-flex min-w-0 items-center gap-[5px] truncate text-[12px] text-sh-text-2">
        {!plain && <Diamond />}
        {label}
      </span>
    </>
  )
}

/** After Stop, while the last words are being turned into English. */
function Processing({ className }: { className?: string }) {
  return (
    <p role="status" className={cn('flex items-center gap-[8px] text-[13px] text-sh-text-2', className)}>
      <Icon icon={Loader} size={14} className="shrink-0 animate-spin motion-reduce:animate-none" />
      Processing…
    </p>
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
