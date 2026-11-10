/**
 * A block of words that must be read — the old build's `Alert`
 * (`src/components/primitives.tsx`): a tone, a title, the body, and an action
 * where there is one. The icon and the title carry the meaning, never the
 * colour alone.
 */

import { CircleAlert, Info, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '../lib/cn'

import { Icon } from './primitives'

type AlertTone = 'warn' | 'crit' | 'info'

const TONE: Record<AlertTone, { box: string; icon: LucideIcon }> = {
  warn: { box: 'bg-sh-warn-bg text-sh-warn-fg', icon: TriangleAlert },
  crit: { box: 'bg-sh-crit-bg text-sh-crit-fg', icon: CircleAlert },
  info: { box: 'bg-sh-inner text-sh-text', icon: Info },
}

export function Alert({
  tone = 'info',
  icon,
  title,
  action,
  role,
  className,
  children,
}: {
  tone?: AlertTone
  /** Overrides the tone's own icon. */
  icon?: LucideIcon
  title: ReactNode
  action?: ReactNode
  role?: 'alert' | 'status'
  className?: string
  children?: ReactNode
}) {
  const t = TONE[tone]
  return (
    <div role={role} className={cn('flex flex-wrap items-start gap-x-[12px] gap-y-[8px] rounded-[16px] px-[16px] py-[12px]', t.box, className)}>
      <Icon icon={icon ?? t.icon} size={17} className="mt-[2px] shrink-0" />
      <div className="min-w-0 flex-1 basis-[240px]">
        <p className="text-[14px] font-semibold">{title}</p>
        {children && <div className="mt-[4px] text-[13px]/[1.55] text-sh-text-2">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
