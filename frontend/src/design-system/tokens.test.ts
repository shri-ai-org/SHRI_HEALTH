// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]))
}

const light = tokens(css.slice(css.indexOf('@theme static'), css.indexOf('@layer base')))
const dark = { ...light, ...tokens(css.slice(css.indexOf('.dark {'), css.indexOf("html[data-large-text='true']"))) }

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

// Text pairs need 4.5:1 (WCAG 1.4.3). Borders that mark a control need 3:1 (WCAG 1.4.11).
const TEXT_PAIRS: Array<[string, string]> = [
  ['ink', 'bg'], ['ink', 'surface-1'], ['ink', 'surface-2'],
  ['ink-muted', 'surface-1'], ['ink-muted', 'surface-2'], ['ink-muted', 'bg'],
  ['ink-subtle', 'surface-1'], ['ink-subtle', 'surface-2'], ['ink-subtle', 'bg'],
  ['on-primary', 'primary-600'],
  ['primary-700', 'surface-1'], ['primary-700', 'primary-50'],
  ['success-fg', 'success-bg'], ['warning-fg', 'warning-bg'], ['critical-fg', 'critical-bg'], ['info-fg', 'info-bg'],
  ['critical-fg', 'surface-1'],
]
const UI_PAIRS: Array<[string, string]> = [
  ['border-strong', 'surface-1'], ['focus', 'surface-1'], ['focus', 'bg'],
]

describe.each([
  ['light', light],
  ['dark', dark],
])('%s theme', (_name, theme) => {
  it.each(TEXT_PAIRS)('%s on %s is at least 4.5:1', (fg, bg) => {
    expect(contrast(theme[fg]!, theme[bg]!)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(UI_PAIRS)('%s on %s is at least 3:1', (fg, bg) => {
    expect(contrast(theme[fg]!, theme[bg]!)).toBeGreaterThanOrEqual(3)
  })
})

describe('U.S. edition wording', () => {
  // Indian-edition fields and terms that must not reach U.S. screens (FRS §9, Stage 1 inventory).
  const BANNED = /\b(aadhaar|abha|uhid|tpa|pin ?code|lakh|crore|opd|ipd|ward|bed no|token no|nabh|nabl|abdm|gst)\b|₹|\+91/i

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f)
      return statSync(p).isDirectory() ? files(p) : [p]
    })
  }

  it('has no Indian-edition terms in the design system or app', () => {
    const src = fileURLToPath(new URL('..', import.meta.url))
    const offenders = files(src)
      // Tests may use Indian inputs on purpose, to prove they are rejected.
      .filter((f) => /\.(tsx?|css)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .flatMap((f) => readFileSync(f, 'utf8').split('\n').map((line, i) => ({ f, i, line })))
      .filter(({ line }) => BANNED.test(line))
      .map(({ f, i, line }) => `${f}:${i + 1}: ${line.trim()}`)
    expect(offenders).toEqual([])
  })
})
