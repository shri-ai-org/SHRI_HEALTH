import { cn } from '../lib/cn'

import logoMark from './logo-mark.webp'

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

/** Where the mark leads: Shri AI's home page. */
export const SHRI_HOME = 'https://shri-ai.org'

/**
 * §4.1 #2 — mark + "Shri Health", linking to shri-ai.org. Under 768px the
 * mark alone, still the same link, on a 44px target.
 */
export function Logo() {
  return (
    <>
      <a href={SHRI_HOME} className="inline-flex size-[44px] shrink-0 items-center justify-center rounded-full sm:hidden" aria-label="Shri Health — shri-ai.org">
        <LogoMark size={32} />
      </a>
      <a href={SHRI_HOME} className="flex min-h-[44px] items-center gap-[10px] rounded-full pr-2 text-sh-text max-sm:hidden" aria-label="Shri Health — shri-ai.org">
        <LogoMark />
        <span className="whitespace-nowrap text-[24px]/none font-medium tracking-[-0.02em] shdark:font-sh-serif shdark:text-[30px] shdark:font-normal shdark:tracking-normal">
          Shri Health
        </span>
      </a>
    </>
  )
}
