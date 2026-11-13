import { useState } from 'react'
import { Button } from '../../components/ui/Button'
import { inputClass, labelClass } from '../../utils/formClasses'
import type { CodedChoice } from '../../../shri-health/rooming'
import { problemMessage } from '../../../shri-health/client'

/** What was typed, the RxNorm matches found for it, and the one picked ('' = record as typed). */
export interface CodedValue {
  text: string
  matches: CodedChoice[] | null
  picked: string
}

export const NO_CODED: CodedValue = { text: '', matches: null, picked: '' }

/** The entry to save: the picked RxNorm concept, else the text as typed. */
export function codedEntry(v: CodedValue): string | CodedChoice {
  return v.matches?.find((m) => m.code === v.picked) ?? v.text.trim()
}

/**
 * A name with an RxNorm search (M3): type, Find, pick a match. "None of these" keeps the text as
 * typed, which is saved but can't trigger a prescribing alert, and the note says so. Drug names
 * only go in the search (D13).
 */
export function CodedSearch({
  id,
  label,
  placeholder,
  value,
  onChange,
  find,
  note,
  disabled,
}: {
  id: string
  label: string
  placeholder: string
  value: CodedValue
  onChange: (next: CodedValue) => void
  find: (query: string) => Promise<CodedChoice[]>
  note: string
  disabled: boolean
}) {
  const [searching, setSearching] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const tooShort = value.text.trim().length < 2

  async function search() {
    if (tooShort) return
    setSearching(true)
    setProblem(null)
    try {
      const matches = await find(value.text)
      onChange({ ...value, matches, picked: matches[0]?.code ?? '' })
    } catch (e) {
      setProblem(problemMessage(e))
    } finally {
      setSearching(false)
    }
  }

  const typedOnly = value.matches !== null && value.picked === ''
  return (
    <div className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          value={value.text}
          maxLength={200}
          placeholder={placeholder}
          onChange={(e) => onChange({ text: e.target.value, matches: null, picked: '' })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void search()
            }
          }}
          className={inputClass}
        />
        <Button variant="outline" onClick={() => void search()} disabled={disabled || searching || tooShort} aria-label={`Find ${label.toLowerCase()}`}>
          {searching ? 'Finding…' : 'Find'}
        </Button>
      </div>
      {problem ? <p className="text-sm text-critical-fg">{problem}</p> : null}
      {value.matches !== null ? (
        value.matches.length === 0 ? (
          <p className="text-sm text-ink-muted">No match in the drug list; it will be recorded as typed.</p>
        ) : (
          <>
            <label htmlFor={`${id}-match`} className={labelClass}>
              Match
            </label>
            <select id={`${id}-match`} value={value.picked} onChange={(e) => onChange({ ...value, picked: e.target.value })} className={inputClass}>
              {value.matches.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.display}
                </option>
              ))}
              <option value="">None of these: record as typed</option>
            </select>
          </>
        )
      ) : null}
      <p className={typedOnly || value.matches?.length === 0 ? 'text-xs font-medium text-warning-fg' : 'text-xs text-ink-muted'}>{note}</p>
    </div>
  )
}
