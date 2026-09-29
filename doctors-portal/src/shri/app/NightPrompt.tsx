import { Moon, X } from 'lucide-react'

import type { ScreenSpec } from '@/atlas/registry'
import { useSession } from '@/store/session'

import { useShri } from '../state/store'
import { Icon, RoundButton } from '../ui/primitives'

/**
 * The atlas makes night mandatory on some screens (§5.3 — ICU, radiology
 * reading rooms, stroke calls at 03:00). As in the old build the rule is
 * surfaced, not enforced: one pill, one click, dismissible, and the theme
 * never switches underneath you. The old build's night is this build's dark.
 */
export function NightPrompt({ spec }: { spec: ScreenSpec }) {
  const theme = useShri((s) => s.theme)
  const setTheme = useShri((s) => s.setTheme)
  const dismissed = useSession((s) => s.nightPromptDismissed)
  const dismiss = useSession((s) => s.dismissNightPrompt)
  if (!spec.nightDefault || theme !== 'light' || dismissed) return null
  return (
    // 6px in from the edge: the 34px Dismiss keeps a 44px target, which on a bare screen (the wall) would reach past it.
    <div className="mb-[12px] flex justify-end px-[6px]">
      <span className="inline-flex items-center gap-[2px] rounded-full bg-sh-card py-[2px] pl-[4px] pr-[2px]">
        <button
          type="button"
          onClick={() => setTheme('dark')}
          title="This screen is specified for night use — ICU, radiology reading rooms and stroke calls happen at 03:00."
          className="inline-flex h-[40px] items-center gap-[6px] rounded-full px-[12px] text-[13px] font-medium text-sh-text-2 hover:bg-sh-hover"
        >
          <Icon icon={Moon} size={15} />
          Night recommended
        </button>
        <RoundButton icon={X} label="Dismiss" size={34} iconSize={14} variant="ghost" onClick={dismiss} />
      </span>
    </div>
  )
}
