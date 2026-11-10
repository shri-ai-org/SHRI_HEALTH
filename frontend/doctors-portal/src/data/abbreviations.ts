/**
 * AI-114 · CMP-NABH-05 — the banned abbreviations, and AI-104's tidy-up.
 *
 * "Checked ON BLUR", and banned abbreviations are rejected rather than warned
 * about — so the message names the replacement. The same table drives the
 * tidy-up: instead of only refusing, the AI offers to write the full words.
 *
 * Everything here is deterministic. It is presented under an AI capability
 * because that is what the atlas calls dictation clean-up (AI-104), and because
 * the clinician must be able to accept, undo and see what changed.
 */

export interface BannedRule {
  pattern: RegExp
  write: string
  /** Where the fix is a plain substitution. Absent where only a message makes sense. */
  replace?: string
}

export const BANNED: BannedRule[] = [
  { pattern: /\bOD\b/g, write: 'once daily', replace: 'once daily' },
  { pattern: /\bBD\b/g, write: 'twice daily', replace: 'twice daily' },
  { pattern: /\bTDS\b/g, write: 'three times daily', replace: 'three times daily' },
  { pattern: /\bQID\b/g, write: 'four times daily', replace: 'four times daily' },
  { pattern: /\bHS\b/g, write: 'at night', replace: 'at night' },
  { pattern: /\b(SOS|PRN)\b/g, write: 'when required', replace: 'when required' },
  { pattern: /\bIU\b|\bU\b/g, write: 'units', replace: 'units' },
  { pattern: /\bcc\b/g, write: 'mL', replace: 'mL' },
  { pattern: /µg|\bug\b/g, write: 'mcg', replace: 'mcg' },
  { pattern: /(\d+)\.0\b/g, write: 'the whole number, with no trailing zero', replace: '$1' },
]

export function bannedIn(text: string): { found: string; write: string }[] {
  const hits: { found: string; write: string }[] = []
  for (const rule of BANNED) {
    rule.pattern.lastIndex = 0
    const m = rule.pattern.exec(text)
    if (m) hits.push({ found: m[0], write: rule.write })
  }
  return hits
}

export interface TidyResult {
  text: string
  /** Human-readable list of what changed, for the strip under the field. */
  changes: string[]
}

/**
 * Sentence case, single spacing, a full stop at the end, and every banned
 * abbreviation written out. Never touches clinical content: no words are
 * added, removed or reordered beyond the substitutions the table names.
 */
export function tidyText(input: string): TidyResult {
  const changes: string[] = []
  let text = input

  for (const rule of BANNED) {
    if (rule.replace === undefined) continue
    rule.pattern.lastIndex = 0
    const before = text
    text = text.replace(rule.pattern, rule.replace)
    if (text !== before) changes.push(rule.replace === '$1' ? 'no trailing .0' : `wrote "${rule.write}"`)
  }

  const spaced = text.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/([,.;:])(?=[^\s\d])/g, '$1 ').trim()
  if (spaced !== text) changes.push('spacing')
  text = spaced

  const cased = text.replace(/(^|[.!?]\s+)([a-z])/g, (_, lead: string, ch: string) => lead + ch.toUpperCase())
  if (cased !== text) changes.push('sentence case')
  text = cased

  if (text && !/[.!?]$/.test(text)) {
    text = `${text}.`
    changes.push('full stop')
  }

  return { text, changes }
}
