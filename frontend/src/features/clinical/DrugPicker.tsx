import { useState } from 'react'
import { searchCodes } from '../../api/generated/endpoints/encounters/encounters'
import type { CodeMatch } from '../../api/generated/model'
import { Button, Field, Select, TextInput, type Problem } from '../../design-system'
import { catchProblem } from './parts'

/** What the user typed, the RxNorm matches found for it, and the one picked (`system|code`, or '' for "as typed"). */
export interface DrugChoice {
  query: string
  matches: CodeMatch[] | null
  picked: string
}

export const NO_DRUG: DrugChoice = { query: '', matches: null, picked: '' }

const keyOf = (m: CodeMatch) => `${m.system}|${m.code}`

/**
 * The chosen drug as the contract's CodeableConcept: coded in RxNorm when one was picked, which is
 * what the prescription safety check matches on (D99), otherwise the text as typed. `null` when
 * nothing was chosen or typed.
 */
export function drugConcept(c: DrugChoice): { codings?: Array<{ system: string; code: string; display: string }>; text: string } | null {
  const match = c.matches?.find((m) => keyOf(m) === c.picked)
  if (match) return { codings: [{ system: match.system, code: match.code, display: match.display }], text: match.display }
  const text = c.query.trim()
  return text ? { text } : null
}

/** A drug name with an RxNorm search (`GET /codes?system=rxnorm`); anything else can be typed. */
export function DrugPicker({
  label,
  matchLabel,
  hint,
  value,
  onChange,
  error,
  onProblem,
}: {
  label: string
  /** The list of matches; distinct per picker, since a screen may have two. */
  matchLabel: string
  hint: string
  value: DrugChoice
  onChange: (next: DrugChoice) => void
  error?: string | undefined
  onProblem: (p: Problem) => void
}) {
  const [tooShort, setTooShort] = useState(false)

  async function search() {
    const q = value.query.trim()
    setTooShort(q.length < 2)
    if (q.length < 2) return
    try {
      // Drug names only: no patient data goes in this query string (D13).
      const res = await searchCodes({ system: 'rxnorm', q, limit: 10 })
      if (res.status === 200) onChange({ ...value, matches: res.data.items, picked: res.data.items[0] ? keyOf(res.data.items[0]) : '' })
    } catch (e) {
      catchProblem(onProblem)(e)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <Field label={label} hint={hint} error={tooShort ? 'Enter at least 2 letters.' : error}>
            {(p) => (
              <TextInput
                {...p}
                value={value.query}
                onChange={(e) => {
                  setTooShort(false)
                  onChange({ query: e.target.value, matches: null, picked: '' })
                }}
              />
            )}
          </Field>
        </div>
        <Button variant="outline" aria-label={`Search drugs for ${label.toLowerCase()}`} onClick={() => void search()}>
          Search drugs
        </Button>
      </div>
      {value.matches ? (
        value.matches.length === 0 ? (
          <p className="text-sm text-ink-muted">No drug matches; it will be recorded as typed.</p>
        ) : (
          <Field label={matchLabel}>
            {(p) => (
              <Select {...p} value={value.picked} onChange={(e) => onChange({ ...value, picked: e.target.value })}>
                {value.matches!.map((m) => (
                  <option key={keyOf(m)} value={keyOf(m)}>
                    {m.display}
                  </option>
                ))}
                <option value="">None of these: record as typed</option>
              </Select>
            )}
          </Field>
        )
      ) : null}
    </>
  )
}
