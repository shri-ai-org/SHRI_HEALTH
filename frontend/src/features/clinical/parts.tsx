import type { ReactNode } from 'react'
import { ApiError } from '../../api/client'
import type { Problem } from '../../design-system'

/** One titled section of a clinical screen. */
export function Panel({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-4 rounded-xl border border-border bg-surface-1 p-5">
      <h2 id={id} className="text-lg font-semibold text-ink">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** Shows an API refusal; anything else is a bug and is rethrown. */
export function catchProblem(set: (p: Problem) => void) {
  return (error: unknown) => {
    if (error instanceof ApiError) set(error.problem)
    else throw error
  }
}
