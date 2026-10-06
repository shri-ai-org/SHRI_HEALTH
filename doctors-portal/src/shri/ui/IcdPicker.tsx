/**
 * ICD-10, picked the same way everywhere a diagnosis is coded — the note's
 * code, the problem list, admission, discharge, a prescription line, the death
 * certificate, the cohort filters.
 *
 * `IcdPicker` is the search: a combobox over the dictionary (`data/icd10.ts`)
 * plus the caller's own codes (the patient's problems, the AI's proposals),
 * which come first. ↑/↓ move, Enter picks, Esc closes. A parent code is
 * listed but cannot be picked unless `allowParents` (the AI-501 rule: a
 * category is never the coded diagnosis — only a cohort filter may use one).
 *
 * `IcdField` is the form field built on it: the chosen code(s) as removable
 * chips, one-tap chips for the patient's own diagnoses, and the search.
 * Never required by itself — a caller decides that.
 */

import { Plus, X } from 'lucide-react'
import { useId, useMemo, useState, type KeyboardEvent } from 'react'

import { icdCategoriesOf, normaliseIcd, searchIcd, type IcdCode, type IcdEntry } from '@/data/icd10'

import { cn } from '../lib/cn'

import { TextInput } from './forms'
import { Chip, Icon } from './primitives'

export function IcdPicker({
  id,
  onPick,
  extra = [],
  allowParents = false,
  categories = false,
  selected = [],
  placeholder = 'Search ICD-10 by code or diagnosis…',
  ariaLabel = 'Search ICD-10',
  className,
}: {
  id: string
  onPick: (entry: IcdEntry) => void
  /** The caller's own codes, searched first. */
  extra?: IcdEntry[]
  allowParents?: boolean
  /** Offer each matching code's whole category too (I63 — every I63 code). Cohort filters only. */
  categories?: boolean
  /** Codes already chosen — marked as selected in the list. */
  selected?: string[]
  placeholder?: string
  ariaLabel?: string
  className?: string
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const matches = useMemo(() => {
    const found = searchIcd(query, { extra })
    if (!categories || found.length === 0) return found
    const cats = icdCategoriesOf(found.map((e) => e.code)).filter((c) => !found.some((f) => normaliseIcd(f.code) === c.code))
    return [...cats, ...found].slice(0, 10)
  }, [query, extra, categories])
  const open = query.trim().length >= 2
  const pickable = (e: IcdEntry) => e.leaf || allowParents || categories

  function pick(e: IcdEntry) {
    if (!pickable(e)) return
    onPick(e)
    setQuery('')
    setActive(0)
  }

  function onKey(ev: KeyboardEvent<HTMLInputElement>) {
    if (!open) return
    if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      setActive((a) => Math.min(a + 1, matches.length - 1))
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (ev.key === 'Enter' && matches[active]) {
      ev.preventDefault()
      pick(matches[active])
    } else if (ev.key === 'Escape') {
      setQuery('')
    }
  }

  return (
    <div className={cn('relative max-w-[480px]', className)}>
      <TextInput
        id={id}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onKeyDown={onKey}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
      />
      {open && (
        <ul id={listId} role="listbox" aria-label="ICD-10 matches" className="sh-frosted absolute z-20 mt-[6px] w-full overflow-hidden rounded-[16px] py-[4px] shadow-sh-pop">
          {matches.length === 0 && <li className="px-[14px] py-[10px] text-[13px] text-sh-text-3">No ICD-10 code matches “{query.trim()}”.</li>}
          {matches.map((e, i) => {
            const isCategory = !e.leaf && categories && !e.code.includes('.') && e.code.length === 3
            return (
              <li key={e.code} id={`${listId}-${i}`} role="option" aria-selected={selected.includes(normaliseIcd(e.code))} aria-disabled={!pickable(e)}>
                <button
                  type="button"
                  tabIndex={-1}
                  disabled={!pickable(e)}
                  title={pickable(e) ? undefined : 'Parent-only code — pick a code under it'}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(e)}
                  className={cn(
                    'flex min-h-[44px] w-full items-center gap-[12px] px-[14px] text-left transition-colors duration-150 hover:bg-sh-hover disabled:cursor-not-allowed disabled:opacity-50',
                    i === active && 'bg-sh-hover',
                  )}
                >
                  <span className="w-[72px] shrink-0 text-[13px] font-semibold tabular-nums text-sh-text">{e.code}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-sh-text">
                    {e.label}
                    {isCategory && <span className="text-sh-text-3"> — every {e.code} code</span>}
                  </span>
                  {!e.leaf && !pickable(e) && <Chip word="parent only" tone="warn" />}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function IcdField({
  id,
  label,
  value,
  onChange,
  suggestions = [],
  multiple = false,
  hint,
  disabled = false,
  className,
}: {
  id: string
  label: string
  value: IcdCode[]
  onChange: (next: IcdCode[]) => void
  /** The patient's own diagnoses, offered as one-tap chips. */
  suggestions?: IcdCode[]
  multiple?: boolean
  hint?: string
  disabled?: boolean
  className?: string
}) {
  const chosen = new Set(value.map((v) => normaliseIcd(v.code)))
  const add = (c: IcdCode) => {
    const code = normaliseIcd(c.code)
    if (chosen.has(code)) return
    onChange(multiple ? [...value, { code, label: c.label }] : [{ code, label: c.label }])
  }
  const remove = (code: string) => onChange(value.filter((v) => normaliseIcd(v.code) !== code))
  const offered = suggestions.filter((s) => !chosen.has(normaliseIcd(s.code)))

  return (
    <div className={cn('flex flex-col gap-[8px]', className)} role="group" aria-labelledby={`${id}-label`}>
      <span id={`${id}-label`} className="text-[13px] font-medium text-sh-text-2">
        {label}
      </span>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-[8px]" aria-label={`${label}: chosen`}>
          {value.map((v, i) => (
            <li key={v.code}>
              <span className="inline-flex min-h-[44px] items-center gap-[8px] rounded-full bg-sh-accent-soft py-[4px] pl-[12px] pr-[4px] text-[13px] text-sh-text">
                <span className="font-semibold tabular-nums">{v.code}</span>
                <span className="max-w-[260px] truncate">{v.label}</span>
                {multiple && i === 0 && value.length > 1 && <Chip word="principal" tone="pend" />}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => remove(normaliseIcd(v.code))}
                    aria-label={`Remove ${v.code} ${v.label}`}
                    className="inline-flex size-[36px] items-center justify-center rounded-full text-sh-text-3 transition-colors duration-150 hover:bg-sh-hover hover:text-sh-text"
                  >
                    <Icon icon={X} size={14} />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!disabled && offered.length > 0 && (multiple || value.length === 0) && (
        <div className="flex flex-wrap gap-[8px]" aria-label="The patient’s diagnoses">
          {offered.map((s) => (
            <button
              key={s.code}
              type="button"
              onClick={() => add(s)}
              className="inline-flex min-h-[44px] items-center gap-[6px] rounded-full bg-sh-inner px-[14px] text-left text-[13px] text-sh-text transition-colors duration-150 hover:bg-sh-hover-strong"
            >
              <Icon icon={Plus} size={13} className="text-sh-text-3" />
              {s.label} · {s.code}
            </button>
          ))}
        </div>
      )}
      {!disabled && (multiple || value.length === 0) && (
        <div>
          <IcdPicker id={id} onPick={add} selected={[...chosen]} ariaLabel={`Search ICD-10 for ${label.toLowerCase()}`} />
        </div>
      )}
      {hint && <p className="text-[12px] text-sh-text-3">{hint}</p>}
    </div>
  )
}
