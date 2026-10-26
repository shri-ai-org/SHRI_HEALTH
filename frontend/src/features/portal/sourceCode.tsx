/**
 * Where users can get the source of the running build (AGPL-3.0 §13; D76, D87). CI stamps
 * `VITE_SOURCE_CODE_URL` with a download for the exact commit it builds (Q31); local builds fall back
 * to the repository.
 */
export const SOURCE_CODE_URL: string = import.meta.env.VITE_SOURCE_CODE_URL ?? 'https://github.com/shri-ai-org/SHRI_HEALTH'

/** Shown on every portal page, signed in or not: every network user is offered the source. */
export function SourceCodeLink({ className }: { className?: string }) {
  return (
    <a href={SOURCE_CODE_URL} rel="noreferrer" className={className ?? 'underline-offset-2 hover:underline'}>
      Source code
    </a>
  )
}
