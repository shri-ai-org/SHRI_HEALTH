/**
 * Live words as a read-only block, typed in as they arrive (`logic/typewriter.ts`):
 * the settled English, then the words still being heard, quieter. For a surface
 * that is not a text box; `VoiceField` types into its box the same way.
 */

import { cn } from '../lib/cn'
import { useTypewriter } from '../logic/typewriter'

export function LiveTranscript({ settled, interim, className }: { settled: string; interim: string; className?: string }) {
  const typedSettled = useTypewriter(settled)
  const typedInterim = useTypewriter(interim)
  return (
    <p aria-live="polite" className={cn('whitespace-pre-wrap text-[14px]/[1.5] text-sh-text', className)}>
      {typedSettled}
      {typedInterim && (
        <span className="text-sh-text-2">
          {typedSettled ? ' ' : ''}
          {typedInterim}
        </span>
      )}
    </p>
  )
}
