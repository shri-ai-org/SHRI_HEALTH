/**
 * Where users get the source of the running build (AGPL-3.0 §13; D76, D87). A fixed path on the
 * portal host serves the running commit's source; the link names no version or commit, because the
 * signed-out pages show it too (Q31, ADR-0013). In development nothing serves it, so it 404s.
 */
export const SOURCE_CODE_URL = '/source.tar.gz'

/** Shown on every portal page, signed in or not: every network user is offered the source. */
export function SourceCodeLink({ className }: { className?: string }) {
  return (
    <a href={SOURCE_CODE_URL} className={className ?? 'underline-offset-2 hover:underline'}>
      Source code
    </a>
  )
}
