/**
 * One value against its reference range, small enough for a list row: the
 * range as a band, the value as a marker on it, the track widened just
 * enough to hold a value outside the band. The flag word always sits beside
 * it in the row, so colour is never the only carrier (§5.3). Hand-built SVG
 * on the theme's tokens.
 */

export function RangeBar({ value, low, high, label, width = 72 }: { value: number; low: number; high: number; label: string; width?: number }) {
  const h = 10
  const span = high - low || Math.abs(high) || 1
  // The track runs a quarter of the range past each end, further if the value is further out.
  const lo = Math.min(low - span * 0.25, value)
  const hi = Math.max(high + span * 0.25, value)
  const x = (v: number) => 1 + ((v - lo) / (hi - lo || 1)) * (width - 2)
  const outside = value < low || value > high
  return (
    <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} role="img" aria-label={label} className="shrink-0 overflow-visible">
      <rect x="0" y="3" width={width} height="4" rx="2" fill="var(--inner)" />
      <rect x={x(low)} y="2" width={Math.max(2, x(high) - x(low))} height="6" rx="3" fill="var(--norm-bg)" stroke="var(--norm)" strokeWidth="1" />
      <circle cx={x(value)} cy="5" r="4" fill={outside ? 'var(--warn)' : 'var(--norm)'} stroke="var(--card)" strokeWidth="1.5" />
    </svg>
  )
}
