import { Link } from 'react-router-dom'

import { cn } from '../lib/cn'

import { P } from './paths'

/** §9 — the 8-point asterisk mark, 28px. */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="currentColor" className={cn('shrink-0', className)} aria-hidden="true">
      <path d="M16 2c1 0 1.6.8 1.6 1.8v7.6l5.4-5.4c.7-.7 1.8-.7 2.4 0 .7.7.7 1.8 0 2.4L20 13.8h7.6c1 0 1.8.7 1.8 1.7s-.8 1.8-1.8 1.8H20l5.4 5.4c.7.7.7 1.8 0 2.4-.7.7-1.8.7-2.4 0l-5.4-5.4v7.6c0 1-.7 1.8-1.7 1.8s-1.8-.8-1.8-1.8v-7.6l-5.4 5.4c-.7.7-1.8.7-2.4 0-.7-.7-.7-1.8 0-2.4l5.4-5.4H4.1c-1 0-1.8-.8-1.8-1.8s.8-1.7 1.8-1.7h7.6L6.3 8.4c-.7-.7-.7-1.8 0-2.4.7-.7 1.8-.7 2.4 0l5.4 5.4V3.8C14.1 2.8 15 2 16 2z" />
    </svg>
  )
}

/** §4.1 #2 — mark + "Shri Health", links to My Day, hidden under 768px. */
export function Logo() {
  return (
    <Link
      to={P.myDay}
      className="flex items-center gap-[10px] rounded-full pr-2 text-sh-text max-sm:hidden"
      aria-label="Shri Health — My Day"
    >
      <LogoMark />
      <span className="whitespace-nowrap text-[24px]/none font-medium tracking-[-0.02em] shdark:font-sh-serif shdark:text-[30px] shdark:font-normal shdark:tracking-normal">
        Shri Health
      </span>
    </Link>
  )
}
