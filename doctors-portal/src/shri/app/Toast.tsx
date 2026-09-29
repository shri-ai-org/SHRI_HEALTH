import { AnimatePresence, motion } from 'framer-motion'
import { Check, Info, OctagonAlert, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { useUI, type Toast as ToastItem } from '@/store/ui'

import { cn } from '../lib/cn'
import { T220 } from '../lib/motion'
import { useShri } from '../state/store'
import { useIsPhone } from '../ui/frames'
import { placeToasts, useLayers } from '../ui/layers'
import { Icon } from '../ui/primitives'

/** Icon + colour for each tone — the icon and the title carry it, never colour alone. */
const TONE: Record<ToastItem['tone'], { icon: LucideIcon; badge: string }> = {
  success: { icon: Check, badge: 'bg-sh-accent text-sh-accent-ink' },
  info: { icon: Info, badge: 'bg-sh-pend-bg text-sh-pend-fg' },
  caution: { icon: TriangleAlert, badge: 'bg-sh-warn-bg text-sh-warn-fg' },
  critical: { icon: OctagonAlert, badge: 'bg-sh-crit-bg text-sh-crit-fg' },
}

/**
 * §6.9, on the old build's toast stack (`useUI`): every toast keeps its tone,
 * title and detail, stays 6s and can be dismissed. Bottom-centre of the
 * viewport, above the tab bar on a phone and always above the home indicator.
 * A new one is announced, never focused (`role="status"`). The stack reports
 * its height so the assistant bubble lifts clear of it.
 *
 * A toast never covers an action. On a screen the stack floats above its
 * action bar; while a modal is open the bar is under the scrim, so the lift
 * goes, and the stack keeps to the free space beside the modal — or beneath
 * it, where there is none (`ui/layers.ts`). A non-dismissible gate is never
 * left with its way out under a toast.
 */
export function Toast() {
  const toasts = useUI((s) => s.toasts)
  const dismiss = useUI((s) => s.dismissToast)
  const setToastLift = useShri((s) => s.setToastLift)
  // The stack floats above a screen's action bar, so a toast never covers Sign.
  const barLift = useShri((s) => s.barLift)
  const toastLift = useShri((s) => s.toastLift)
  const layers = useLayers((s) => s.layers)
  const phone = useIsPhone()
  const stack = useRef<HTMLDivElement>(null)

  // A phone's modal is a full-width sheet or drawer: there is no space beside it, only beneath.
  const place =
    layers.length === 0
      ? null
      : phone
        ? { left: 0, right: 0, z: Math.min(...layers.map((l) => l.z)) - 1 }
        : placeToasts(layers, toastLift, window.innerWidth, window.innerHeight, 26, 80)
  const beside = place !== null && (place.left > 0 || place.right > 0)

  useEffect(() => {
    const el = stack.current
    if (!el) return
    const ro = new ResizeObserver(() => setToastLift(Math.round(el.getBoundingClientRect().height)))
    ro.observe(el)
    return () => {
      ro.disconnect()
      setToastLift(0)
    }
  }, [setToastLift])

  return (
    <div
      className={cn(
        'pointer-events-none fixed bottom-[calc(26px_+_var(--sa-b))] flex justify-center max-sm:bottom-[calc(var(--tabbar-h)_+_var(--sa-b)_+_16px)]',
        !beside && 'px-[16px]',
      )}
      style={{
        zIndex: place?.z ?? 80,
        left: place?.left ?? 0,
        right: place?.right ?? 0,
        ...(place === null && barLift > 0 ? { translate: `0 -${barLift}px` } : {}),
      }}
      role="status"
      aria-live="polite"
    >
      <div ref={stack} className="flex w-full max-w-[520px] flex-col items-center gap-[8px]">
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const tone = TONE[t.tone]
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ y: 8, opacity: 0 }}
                animate={{ y: 0, opacity: 1, transition: T220 }}
                exit={{ y: 8, opacity: 0, transition: { duration: 0.15 } }}
                className="pointer-events-auto flex w-fit max-w-full items-center gap-[10px] rounded-[22px] bg-sh-primary py-[8px] pl-[10px] pr-[6px] text-sh-on-primary shadow-sh-pop"
              >
                <span className={cn('inline-flex size-[26px] shrink-0 items-center justify-center rounded-full', tone.badge)} aria-hidden="true">
                  <Icon icon={tone.icon} size={15} strokeWidth={2.4} />
                </span>
                <span className="min-w-0 flex-1 py-[2px]">
                  <span className="block text-[14px]/[18px] font-medium">{t.title}</span>
                  {t.detail && <span className="mt-[1px] block text-[13px]/[17px] opacity-75">{t.detail}</span>}
                </span>
                <button
                  type="button"
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss"
                  className="inline-flex size-[32px] shrink-0 items-center justify-center rounded-full opacity-70 transition-opacity duration-150 hover:opacity-100"
                >
                  <Icon icon={X} size={16} />
                </button>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </div>
  )
}
