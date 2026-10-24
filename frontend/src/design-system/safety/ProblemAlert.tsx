import type { ReactNode } from 'react'
import { Alert } from '../components/feedback'
import { fieldErrorMessage, fieldKey, problemCopy, type Problem } from '../problem/problem'

export interface ProblemAlertProps {
  problem: Problem
  /** Field labels by JSON pointer or parameter name, e.g. `{ '/birthDate': 'Date of birth' }`. */
  fieldLabels?: Record<string, string>
  actions?: ReactNode
}

/**
 * Shows an API error in plain words chosen by its `code` (never the server's text), the field errors
 * for validation codes, and the request reference for support. Codes that need their own flow
 * (break-glass, record changed, sign-in, duplicates) are routed by the screen with `problemCopy().action`;
 * this banner is the fallback and the message for everything else.
 */
export function ProblemAlert({ problem, fieldLabels = {}, actions }: ProblemAlertProps) {
  const copy = problemCopy(problem)
  const errors = problem.errors ?? []
  return (
    <Alert tone={copy.tone} title={copy.title} actions={actions} assertive={copy.tone === 'critical'}>
      <p>{copy.message}</p>
      {errors.length > 0 ? (
        <ul className="mt-1.5 list-disc pl-5">
          {errors.map((e, i) => {
            const key = fieldKey(e)
            return (
              <li key={`${key}-${i}`}>
                <span className="font-semibold">{fieldLabels[key] ?? key}:</span> {fieldErrorMessage(e.code)}
              </li>
            )
          })}
        </ul>
      ) : null}
      {problem.requestId ? <p className="mt-1.5 text-xs opacity-80">Reference: {problem.requestId}</p> : null}
    </Alert>
  )
}
