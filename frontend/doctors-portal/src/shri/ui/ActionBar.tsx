/**
 * Z7a — a screen's sticky action bar: the primary action and what gates it,
 * pinned to the foot of the viewport while the screen scrolls. It publishes
 * its height (`barLift`), so the toast stack and the assistant bubble float
 * above it — the bubble "NEVER COVERS A PRIMARY ACTION" (§6.1). On a phone it
 * sits above the tab bar.
 */

import { useLayoutEffect, useRef, type ReactNode } from 'react'

import { cn } from '../lib/cn'
import { useShri } from '../state/store'

export function ActionBar({ className, children }: { className?: string; children: ReactNode }) {
  const setBarLift = useShri((s) => s.setBarLift)
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setBarLift(Math.round(el.getBoundingClientRect().height) + 12))
    ro.observe(el)
    return () => {
      ro.disconnect()
      setBarLift(0)
    }
  }, [setBarLift])

  return (
    <div
      ref={ref}
      className={cn(
        'sh-frosted sticky bottom-[calc(12px_+_var(--sa-b))] z-20 flex flex-wrap items-center gap-x-[12px] gap-y-[8px] rounded-sh-card px-[18px] py-[12px] shadow-sh-pop max-sm:bottom-[calc(var(--tabbar-h)_+_var(--sa-b)_+_8px)]',
        className,
      )}
    >
      {children}
    </div>
  )
}
