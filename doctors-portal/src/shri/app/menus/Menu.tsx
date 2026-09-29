import { AnimatePresence, motion } from 'framer-motion'
import { useRef, type ReactNode } from 'react'

import { cn } from '../../lib/cn'
import { popover } from '../../lib/motion'
import { useIsPhone } from '../../ui/frames'
import { useOutsideClick } from '../../ui/hooks'

/**
 * A dropdown anchored under its trigger. Frosted in dark, a plain card in
 * light (§3.2). Closes on an outside pointer; the store closes it when
 * another menu opens. On a phone a trigger can sit anywhere along a 288px
 * bar, so the menu pins full-width under the app bar instead.
 */
export function Menu({
  open,
  onClose,
  width,
  align = 'right',
  label,
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  width: number
  align?: 'left' | 'right'
  label: string
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const phone = useIsPhone()
  useOutsideClick(ref, open, onClose)
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          role="menu"
          aria-label={label}
          variants={popover}
          initial="hidden"
          animate="shown"
          exit="exit"
          style={phone ? undefined : { width }}
          className={cn(
            'sh-frosted z-20 overflow-hidden rounded-[20px] p-[8px] shadow-sh-pop',
            phone
              ? 'fixed left-[max(16px,var(--sa-l))] right-[max(16px,var(--sa-r))] top-[calc(var(--shell-pt)_+_64px)] max-h-[calc(100dvh_-_var(--shell-pt)_-_var(--tabbar-h)_-_var(--sa-b)_-_80px)] overflow-y-auto'
              : cn('absolute top-[calc(100%+8px)] max-w-[calc(100vw-32px)]', align === 'right' ? 'right-0' : 'left-0'),
            className,
          )}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function MenuHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-[10px] pb-[6px] pt-[6px] text-[12px] text-sh-text-3', className)}>{children}</div>
}

export function MenuRow({
  children,
  onClick,
  className,
  current,
  ...rest
}: {
  children: ReactNode
  onClick?: () => void
  className?: string
  current?: boolean
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-current={current ? 'true' : undefined}
      onClick={onClick}
      className={cn(
        // 44px minimum: rows stack edge to edge, so each row's own box is the whole target.
        'flex min-h-[44px] w-full items-center gap-[12px] rounded-[14px] px-[10px] py-[8px] text-left text-sh-text transition-colors duration-150 hover:bg-sh-hover',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
