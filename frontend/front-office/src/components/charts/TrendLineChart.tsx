import { useEffect, useRef, useState } from 'react'

export interface LinePoint {
  key: string
  label: string
  value: number
}

const HEIGHT = 280
const PAD = { top: 24, right: 20, bottom: 52, left: 66 }

/** A rounded-up axis top with 4 even steps (e.g. 0, 10, 20, 30, 40). */
function niceMax(value: number): number {
  if (value <= 4) return 4
  const step = Math.pow(10, Math.floor(Math.log10(value / 4)))
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => s * 4 >= value) ?? step * 10
  return nice * 4
}

/**
 * A small, dependency-free line chart that fills its container's width. The
 * line and points use a theme colour token, gridlines and labels the theme's
 * own border/ink tokens, so it follows light and dark mode. Each point carries
 * its label and value as a tooltip; the data come in as plain points, so a
 * backend feed can replace the source without touching the chart.
 */
export function TrendLineChart({
  points,
  color = 'var(--color-chart-1)',
  ariaLabel,
  unit = 'activities',
  xTitle,
  yTitle,
}: {
  points: LinePoint[]
  /** The line colour — a CSS colour or var(); chart-1 by default. */
  color?: string
  ariaLabel: string
  unit?: string
  /** What the horizontal axis is, e.g. "Hour of the day". */
  xTitle: string
  /** What the vertical axis counts, e.g. "Number of activities". */
  yTitle: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = box.current
    if (!el) return undefined
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const max = niceMax(Math.max(0, ...points.map((p) => p.value)))
  const innerW = Math.max(0, width - PAD.left - PAD.right)
  const innerH = HEIGHT - PAD.top - PAD.bottom
  const x = (i: number) => PAD.left + (points.length <= 1 ? innerW / 2 : (i * innerW) / (points.length - 1))
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const area = points.length ? `${line} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` : ''
  // Keep x labels from colliding: show every nth so each has ~56px.
  const every = Math.max(1, Math.ceil((points.length * 56) / Math.max(innerW, 1)))
  // The busiest point(s) get a filled dot; every point prints its number while
  // there are few enough to read (otherwise only the busiest does).
  const peak = Math.max(0, ...points.map((p) => p.value))
  const showAllValues = points.length <= 14

  return (
    <div ref={box} className="w-full">
      {width > 0 ? (
        <svg width={width} height={HEIGHT} role="img" aria-label={ariaLabel} className="block">
          {[0, 1, 2, 3, 4].map((step) => {
            const value = (max / 4) * step
            return (
              <g key={step}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(value)} y2={y(value)} stroke="var(--color-border-soft)" strokeWidth={1} />
                <text x={PAD.left - 8} y={y(value)} textAnchor="end" dominantBaseline="middle" className="fill-ink-subtle text-2xs tabular-nums">
                  {Math.round(value)}
                </text>
              </g>
            )
          })}
          <path d={area} fill={color} opacity={0.1} />
          <path d={line} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          {points.map((p, i) => {
            const isPeak = peak > 0 && p.value === peak
            return (
            <g key={p.key}>
              <circle cx={x(i)} cy={y(p.value)} r={points.length > 40 ? 2.5 : isPeak ? 5.5 : 4} fill={isPeak ? color : 'var(--color-surface-1)'} stroke={color} strokeWidth={2}>
                <title>{`${p.label}: ${p.value} ${unit}`}</title>
              </circle>
              {(showAllValues && p.value > 0) || isPeak ? (
                <text x={x(i)} y={y(p.value) - 10} textAnchor="middle" className={isPeak ? 'fill-ink text-xs font-bold' : 'fill-ink-muted text-2xs font-semibold'}>
                  {p.value}
                </text>
              ) : null}
              {i % every === 0 || (i === points.length - 1 && (points.length - 1) % every >= every / 2) ? (
                <text x={x(i)} y={HEIGHT - 28} textAnchor="middle" className="fill-ink-subtle text-2xs">
                  {p.label}
                </text>
              ) : null}
            </g>
            )
          })}
          <text x={PAD.left + innerW / 2} y={HEIGHT - 6} textAnchor="middle" className="fill-ink-muted text-xs font-semibold">
            {xTitle}
          </text>
          <text
            transform={`translate(14 ${PAD.top + innerH / 2}) rotate(-90)`}
            textAnchor="middle"
            className="fill-ink-muted text-xs font-semibold"
          >
            {yTitle}
          </text>
        </svg>
      ) : (
        <div style={{ height: HEIGHT }} />
      )}
    </div>
  )
}
