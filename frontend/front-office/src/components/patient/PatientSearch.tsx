import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { IndianRupee, ReceiptText, Search, ShieldCheck, UserPlus } from 'lucide-react'
import { Avatar } from '../ui/Avatar'
import { useStoreValue } from '../../hooks/useStore'
import { hasOpenLayer } from '../../hooks/useLayer'
import { findBillByNumber, getPatientFlags, getPatientSearchSuggestions, searchPatients } from '../../domain/selectors'
import { getAdmittedPatients } from '../../domain/admissionSelectors'
import type { PatientFlags } from '../../domain/selectors'
import type { PatientCareStatus } from '../../domain/patientSelectors'
import { usePatientCareStatus } from '../../hooks/useCareStatus'
import { PatientStatusIcons } from './PatientStatusIcons'
import { billNumberFor, formatRupees } from '../../utils/billing'
import { initialsOf } from '../../utils/format'
import { cn } from '../../utils/cn'
import { abhaKind } from '../../utils/validation'
import type { Patient, PatientSearchMatch } from '../../types/patient'
import type { Payment } from '../../types/payment'

const MAX_MATCHES = 8

type Option =
  | { kind: 'patient'; patient: Patient; section: string; matchedOn?: PatientSearchMatch['matchedOn'] }
  | { kind: 'bill'; bill: Payment; section: string }

type PatientSearchProps =
  | { mode: 'navigate' }
  | {
      mode: 'pick'
      onPick: (patient: Patient) => void
      /** Only patients currently admitted — e.g. issuing a guest pass. */
      scope?: 'inpatients'
      placeholder?: string
      autoFocus?: boolean
      /** The results push the page down instead of floating over it — for a
       *  stacked layout where a floating list would cover the next section. */
      inline?: boolean
    }

/** "/" focuses the app bar search from anywhere — unless the desk is typing
 *  somewhere else or a dialog/flow is open. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return Boolean(el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)))
}

/**
 * The one patient search. In the app bar it opens the patient's profile (a
 * typed bill number opens that bill's payment); inside a flow it picks the
 * patient. Matches appear from the first character, best first; an empty
 * box offers the newest registrations and the most opened profiles.
 */
export function PatientSearch(props: PatientSearchProps) {
  const navigate = useNavigate()
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(props.mode === 'pick' && Boolean(props.autoFocus))
  const [active, setActive] = useState(0)

  const matches = useStoreValue(searchPatients, query)
  const suggestions = useStoreValue(getPatientSearchSuggestions)
  const flags = useStoreValue(getPatientFlags)
  const care = usePatientCareStatus()
  const bill = useStoreValue(findBillByNumber, query)
  const admitted = useStoreValue(getAdmittedPatients)

  const inpatientsOnly = props.mode === 'pick' && props.scope === 'inpatients'
  const allowed = (patient: Patient) => !inpatientsOnly || Boolean(flags[patient.patientId]?.bed)

  const options: Option[] = []
  if (query.trim()) {
    if (bill && props.mode === 'navigate') options.push({ kind: 'bill', bill, section: 'Bill' })
    for (const match of matches.filter((m) => allowed(m.patient)).slice(0, MAX_MATCHES)) {
      options.push({ kind: 'patient', patient: match.patient, section: 'Patients', matchedOn: match.matchedOn })
    }
  } else if (inpatientsOnly) {
    // Picking an inpatient: an empty box lists everyone in a bed.
    for (const patient of admitted) options.push({ kind: 'patient', patient, section: 'Admitted now' })
  } else {
    for (const patient of suggestions.recent.filter(allowed)) options.push({ kind: 'patient', patient, section: 'Recently registered' })
    for (const patient of suggestions.mostOpened.filter(allowed)) options.push({ kind: 'patient', patient, section: 'Most opened' })
  }
  const activeIndex = options.length === 0 ? -1 : Math.min(active, options.length - 1)

  // Picking straight away (e.g. after "Change"): the cursor is already in the box.
  const focusOnMount = props.mode === 'pick' && Boolean(props.autoFocus)
  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus()
  }, [focusOnMount])

  // A floating list closes when the pointer goes elsewhere. An inline one is
  // part of the page: closing it would shift everything below mid-click.
  const inlineList = props.mode === 'pick' && Boolean(props.inline)
  useEffect(() => {
    if (!open || inlineList) return undefined
    function handleMouseDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [open, inlineList])

  const navigateMode = props.mode === 'navigate'
  const inline = props.mode === 'pick' && Boolean(props.inline)
  useEffect(() => {
    if (!navigateMode) return undefined
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target) || hasOpenLayer()) return
      event.preventDefault()
      inputRef.current?.focus()
      setOpen(true)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [navigateMode])

  function choose(option: Option) {
    setOpen(false)
    setQuery('')
    setActive(0)
    if (option.kind === 'bill') {
      navigate(`/payments/${option.bill.paymentId}`)
      return
    }
    if (props.mode === 'pick') props.onPick(option.patient)
    else navigate(`/patients/${option.patient.uhid}`)
    inputRef.current?.blur()
  }

  function register() {
    const text = query.trim()
    const digits = text.replace(/[^0-9]/g, '')
    const prefill = !text
      ? ''
      : /^[+\d\s()-]+$/.test(text) && digits.length >= 3
        ? `?mobile=${digits.slice(-10)}`
        : `?name=${encodeURIComponent(text)}`
    setOpen(false)
    setQuery('')
    navigate(`/register/new${prefill}`)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      if (options.length) setActive((activeIndex + 1) % options.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      if (options.length) setActive((activeIndex - 1 + options.length) % options.length)
    } else if (event.key === 'Enter') {
      if (open && activeIndex >= 0) {
        event.preventDefault()
        choose(options[activeIndex])
      }
    } else if (event.key === 'Escape') {
      if (open) {
        // Close the list only — never the dialog or flow it sits in.
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      } else if (query) {
        event.stopPropagation()
        setQuery('')
      }
    }
  }

  const placeholder =
    props.mode === 'pick' && props.placeholder ? props.placeholder : 'Search name, mobile, UHID, ABHA ID / number or bill no.'
  const showList = open && (options.length > 0 || query.trim().length > 0)

  let lastSection = ''
  const rows: ReactNode[] = options.map((option, index) => {
    const header = option.section !== lastSection ? option.section : null
    lastSection = option.section
    const id = `${listId}-${index}`
    return (
      <li key={option.kind === 'bill' ? `bill-${option.bill.paymentId}` : `${option.section}-${option.patient.patientId}`} role="presentation">
        {header ? (
          <p className="px-3 pb-1 pt-2.5 text-2xs font-semibold uppercase tracking-wide text-ink-subtle" role="presentation">
            {header}
          </p>
        ) : null}
        <div
          id={id}
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActive(index)}
          onClick={() => choose(option)}
          className={cn(
            'mx-1.5 flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2',
            index === activeIndex ? 'bg-primary-50' : 'hover:bg-surface-2',
          )}
        >
          {option.kind === 'bill' ? <BillRow bill={option.bill} /> : (
            <PatientRow
              patient={option.patient}
              flags={flags[option.patient.patientId]}
              care={care[option.patient.patientId]}
              matchedOn={option.matchedOn}
            />
          )}
        </div>
      </li>
    )
  })

  return (
    <div ref={rootRef} className={cn('relative flex min-w-0 gap-2', inline ? 'flex-col' : 'items-center', navigateMode && 'w-full max-w-2xl')}>
      <div className={cn('flex h-11 min-w-0 items-center gap-2 rounded-xl border border-border bg-surface-1 px-3 focus-within:border-primary-600 focus-within:ring-2 focus-within:ring-primary-600/15', inline ? 'flex-none' : 'flex-1')}>
        <Search className="h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.75} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          role="combobox"
          aria-label={navigateMode ? 'Search patients' : placeholder}
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          data-autofocus={props.mode === 'pick' && props.autoFocus ? true : undefined}
          className="h-full w-full min-w-0 bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
        />
        {navigateMode ? (
          <kbd className="hidden shrink-0 rounded border border-border-soft px-1.5 text-2xs text-ink-subtle md:inline">/</kbd>
        ) : null}
      </div>

      {showList ? (
        <div
          className={cn(
            'overflow-y-auto rounded-xl border border-border-soft bg-surface-1 pb-1.5',
            inline ? 'max-h-[min(22rem,55vh)] shadow-card-sm' : 'absolute left-0 right-0 top-full z-40 mt-1.5 max-h-[min(28rem,70vh)] shadow-card-lg',
          )}
        >
          <ul id={listId} role="listbox" aria-label="Patients">
            {rows}
          </ul>
          {options.length === 0 ? (
            <div className="px-4 py-3">
              <p className="text-sm text-ink-muted">No patient found.</p>
              {navigateMode && query.trim() ? (
                // Not found from the search: register them, with what was typed filled in.
                <button
                  type="button"
                  onClick={register}
                  className="focus-ring mt-2 inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary-50 px-3 text-sm font-semibold text-primary-text transition-colors hover:bg-primary-100"
                >
                  <UserPlus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  Register “{query.trim()}” as a new patient
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function PatientRow({
  patient,
  flags,
  care,
  matchedOn,
}: {
  patient: Patient
  flags?: PatientFlags
  care?: PatientCareStatus
  matchedOn?: PatientSearchMatch['matchedOn']
}) {
  return (
    <>
      <Avatar name={patient.name} initials={initialsOf(patient.name)} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-ink">{patient.name}</span>
          <span className="shrink-0 text-xs text-ink-muted">
            {patient.age ? `${patient.age}` : '—'}/{patient.sex.charAt(0)}
          </span>
        </span>
        <span className="block truncate text-xs text-ink-muted">
          {patient.uhid} · {patient.mobile}
        </span>
        {patient.abhaId ? (
          <span
            className={cn(
              'flex items-center gap-1 truncate text-xs',
              matchedOn === 'ABHA ID' || matchedOn === 'ABHA number' ? 'font-semibold text-primary-text' : 'text-ink-subtle',
            )}
          >
            <ShieldCheck className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden="true" />
            <span className="truncate">
              {abhaKind(patient.abhaId)} {patient.abhaId}
            </span>
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <PatientStatusIcons status={care} showDetail />
        {flags && flags.due > 0 ? (
          <span
            className={cn('flex items-center gap-0.5 text-xs font-semibold tabular-nums', flags.failed ? 'text-critical-fg' : 'text-warning-fg')}
            title={flags.failed ? 'Payment failed' : 'Payment pending'}
          >
            <IndianRupee className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">{flags.failed ? 'Payment failed,' : 'Payment pending,'}</span>
            {formatRupees(flags.due).replace('₹', '')}
          </span>
        ) : null}
      </span>
    </>
  )
}

function BillRow({ bill }: { bill: Payment }) {
  return (
    <>
      <span style={{ '--tone': 'var(--color-hue-amber)' } as CSSProperties} className="chip-solid flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
        <ReceiptText className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">{billNumberFor(bill)}</span>
        <span className="block truncate text-xs text-ink-muted">
          {bill.patientName} · {formatRupees(bill.totalAmount)}
          {bill.balance > 0 ? ` · ${formatRupees(bill.balance)} due` : ' · settled'}
        </span>
      </span>
    </>
  )
}
