import type { CSSProperties, ElementType, ReactNode } from 'react'
import type { IconTone } from '../../utils/toneHex'
import { Sparkline } from '../charts/Sparkline'

/**
 * One dashboard figure (DESIGN_SYSTEM §9.4 KPI tile): a pastel card in its
 * hue, a solid gradient icon chip, an optional sparkline, the count in ink,
 * a label and a hint in the hue's ink. The words carry the meaning, so
 * colour is never the only signal.
 *
 * `figureClasses` + `figureStyle` (utils/figure.ts) style the outer element
 * (a button, link or plain div); `FigureBody` is what goes inside.
 */
export function FigureBody({
  icon: Icon,
  hue,
  value,
  label,
  hint,
  trend,
}: {
  icon: ElementType
  hue: IconTone
  value: ReactNode
  label: string
  hint?: ReactNode
  /** A small series (e.g. per hour today) drawn as a sparkline top-right. */
  trend?: number[]
}) {
  return (
    <>
      {/* A large, faint watermark of the icon in the card's hue. */}
      <Icon
        aria-hidden="true"
        strokeWidth={1.5}
        className="pointer-events-none absolute -bottom-3 -right-3 h-20 w-20 text-[var(--fig-tone)] opacity-[0.07] dark:opacity-[0.1]"
      />
      <span className="relative flex w-full items-start justify-between gap-2">
        {/* A solid gradient chip in the card's hue. */}
        <span
          aria-hidden="true"
          data-hue={hue}
          style={{ '--tone': 'var(--fig-tone)' } as CSSProperties}
          className="chip-solid inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] sm:h-9 sm:w-9"
        >
          <Icon size={17} strokeWidth={2} />
        </span>
        {trend && trend.length > 1 ? <Sparkline values={trend} color="var(--fig-tone)" className="mt-1 h-7 w-[42%] max-w-24 shrink" /> : null}
      </span>
      <span className="relative w-full min-w-0 [overflow-wrap:break-word] hyphens-auto">
        <span className="block text-xl font-bold leading-none tracking-[-0.03em] tabular-nums text-ink sm:text-2xl">{value}</span>
        <span className="mt-1 block text-xs font-semibold leading-tight text-ink sm:text-sm">{label}</span>
        {hint ? (
          <span style={{ '--tone': 'var(--fig-tone)' } as CSSProperties} className="ink-tone mt-0.5 line-clamp-2 block text-2xs font-medium leading-snug sm:text-xs">
            {hint}
          </span>
        ) : null}
      </span>
    </>
  )
}
