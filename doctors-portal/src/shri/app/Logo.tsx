import { Link } from 'react-router-dom'

import { cn } from '../lib/cn'

import logoMark from './logo-mark.webp'
import { P } from './paths'

/**
 * §9 — the Shri Health mark, 36px tall. Drawn from brand/logo-source.png by
 * scripts/brand-assets.py at twice this height; small enough that Vite inlines
 * it, so it paints with the page and costs no request.
 */
/** The mark's exported size (brand-assets.py), so the frame is reserved before it paints. */
const MARK_W = 43
const MARK_H = 72

export function LogoMark({ size = 36, className }: { size?: number; className?: string }) {
  return <img src={logoMark} alt="" width={Math.round((size * MARK_W) / MARK_H)} height={size} decoding="async" className={cn('shrink-0 select-none', className)} draggable={false} />
}

/**
 * §4.1 #2 — mark + "Shri Health", links to My Day. Under 768px the mark alone,
 * as a picture rather than a link: the bottom bar's Home is My Day there, and
 * the row has no room for a second 44px target.
 */
export function Logo() {
  return (
    <>
      <LogoMark size={32} className="sm:hidden" />
      <Link
        to={P.myDay}
        className="flex min-h-[44px] items-center gap-[10px] rounded-full pr-2 text-sh-text max-sm:hidden"
        aria-label="Shri Health — My Day"
      >
        <LogoMark />
        <span className="whitespace-nowrap text-[24px]/none font-medium tracking-[-0.02em] shdark:font-sh-serif shdark:text-[30px] shdark:font-normal shdark:tracking-normal">
          Shri Health
        </span>
      </Link>
    </>
  )
}
