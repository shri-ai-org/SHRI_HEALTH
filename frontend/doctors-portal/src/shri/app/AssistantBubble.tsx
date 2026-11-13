import { motion, useReducedMotion } from 'framer-motion'
import { useLocation } from 'react-router-dom'

import { EASE } from '../lib/motion'
import { assistantOfferedAt } from '../logic/assistant'
import { useAiActive } from '../state/ai'
import { useShri } from '../state/store'
import { AssistantIcon } from '../ui/AssistantIcon'
import { useIsPhone } from '../ui/frames'

/**
 * §4.3 — the RAG assistant bubble, wearing the old build's assistant face
 * (`src/components/assistant-icon.tsx`) at the user's request rather than the
 * spec's Sparkles glyph. 62px, bottom-right of the viewport (30px
 * in, 16px on a phone, plus the safe-area inset), and on a phone it sits above
 * the tab bar. It lifts clear of the toast stack while one shows. Never opens by
 * itself. Hidden when AI is off, and on a phone while the assistant sheet is
 * open — the sheet covers its spot and carries its own close. Absent, too,
 * wherever the screen has no GP-17 line (`assistantOfferedAt`).
 *
 * The resting place is CSS, so it can follow breakpoints and insets; the lift
 * is a transform, so it never fights that.
 */
export function AssistantBubble() {
  const aiOn = useAiActive()
  const open = useShri((s) => s.assistantOpen)
  const nudge = useShri((s) => s.assistantNudge)
  const toastLift = useShri((s) => s.toastLift)
  const barLift = useShri((s) => s.barLift)
  // Above a screen's action bar (Z7a) always, and above a toast when one shows — never over a primary action.
  const lift = barLift + (toastLift > 0 ? toastLift + 16 : 0)
  const toggle = useShri((s) => s.toggleAssistant)
  const reduced = useReducedMotion()
  const phone = useIsPhone()
  const { pathname } = useLocation()
  if (!aiOn || (phone && open) || !assistantOfferedAt(pathname)) return null
  return (
    <motion.button
      type="button"
      aria-label="Assistant"
      title="Assistant  ?"
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={toggle}
      initial={false}
      animate={{ y: lift > 0 ? -lift : 0 }}
      whileHover={{ scale: 1.04 }}
      transition={{ duration: reduced ? 0 : 0.2, ease: EASE }}
      className="fixed bottom-[calc(30px_+_var(--sa-b))] right-[calc(30px_+_var(--sa-r))] z-36 flex size-[62px] items-center justify-center rounded-full bg-(--bubble-bg) text-(--bubble-icon) max-sm:bottom-[calc(var(--tabbar-h)_+_var(--sa-b)_+_16px)] max-sm:right-[calc(16px_+_var(--sa-r))]"
      style={{ boxShadow: 'var(--bubble-ring)' }}
    >
      {/* The old build's face for the RAG assistant, on a white disc in both themes so it keeps its own colours. */}
      <AssistantIcon className="size-[48px]" />
      {nudge && !open && (
        <span className="absolute right-[4px] top-[4px] size-[12px] rounded-full bg-sh-crit ring-2 ring-(--surface)" aria-hidden="true" />
      )}
    </motion.button>
  )
}
